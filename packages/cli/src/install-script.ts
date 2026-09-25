import { CliError } from './errors.js';

/**
 * The `bcd` install script (PLAN.md §3.3 step 2, §6 "Install"): a POSIX sh script that
 * - reads the join token only from BCD_JOIN_TOKEN or standard input, never from arguments or a URL;
 * - downloads the pinned bcd for the machine's architecture and verifies its SHA-256;
 * - installs /usr/local/bin/bcd, /etc/bcd/config.toml (0600; the daemon's TOML subset: gateway URL,
 *   site and the three key pins), the JoinService encryption key (public) and a hardened bcd.service;
 * - runs `bcd join` with the token on standard input, then enables and starts the service.
 * Without a token on a host that is already configured it upgrades in place (the v0.1-v0.3 upgrade
 * path), keeping the sections the operator configured ([plugins], [boot], [imds]…). A node whose config has a
 * [plugins] section gets the bcx plugin drop-in (their own uids and cgroups); others keep the tighter unit.
 * Every embedded value is validated against a narrow character set, so nothing a caller passes
 * can break out of the shell or TOML quoting.
 */

export type BcdArch = 'amd64' | 'arm64';

export interface InstallScriptOptions {
  poolId: string;
  siteId: string;
  /** The regional gateway the daemon dials (https). */
  gatewayUrl: string;
  /** Where the control plane serves downloads: `{downloadsBase}/bcd/{version}/linux-{arch}`. */
  downloadsBase: string;
  version: string;
  /** SHA-256 (hex) of the binary per architecture; architectures without one are refused. */
  sha256: Partial<Record<BcdArch, string>>;
  servingCaSpkiPin: string;
  joinSigningKeyPin: string;
  joinEncryptionKeyPin: string;
  /** The JoinService encryption key bcd seals the token to (public; checked against its pin). */
  joinEncryptionJwk: { kty: string; crv: string; x: string; y: string };
  /**
   * bcx driver plugins on this node (PLAN.md §5.5): a [plugins] section (dir, a delegated cgroup) in config.toml.
   * `privileged` names the plugins that run as root without the seccomp filter (a Kata runtime plugin).
   */
  plugins?: { privileged?: readonly string[] };
  /** Generation stamp for the header comment. */
  generatedAt?: string;
  generator?: string;
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const versionPattern = /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const pinPattern = /^sha256\/[A-Za-z0-9+/]{43}=$/;
const hexPattern = /^[0-9a-f]{64}$/;
const base64urlPattern = /^[A-Za-z0-9_-]{43}$/;
const safeUrlPattern = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/;

function invalid(field: string, detail: string): CliError {
  return new CliError('INVALID_INPUT', `${field} ${detail}`);
}

function checkUrl(field: string, value: string): string {
  if (!safeUrlPattern.test(value))
    throw invalid(field, 'must be an https:// URL of letters, digits and . - _ ~ /');
  return value.replace(/\/+$/, '');
}

/** Validates the options; returns them normalized. Throws `INVALID_INPUT` naming the field. */
export function checkInstallScriptOptions(options: InstallScriptOptions): InstallScriptOptions {
  for (const [field, value] of [
    ['--pool', options.poolId],
    ['--site', options.siteId],
  ] as const)
    if (!idPattern.test(value)) throw invalid(field, 'must be an id of letters, digits and . _ -');
  if (!versionPattern.test(options.version))
    throw invalid('--bcd-version', 'must be a semantic version');
  for (const [field, value] of [
    ['serving CA pin', options.servingCaSpkiPin],
    ['join signing key pin', options.joinSigningKeyPin],
    ['join encryption key pin', options.joinEncryptionKeyPin],
  ] as const)
    if (!pinPattern.test(value)) throw invalid(field, 'must be sha256/<base64 of 32 bytes>');
  const arches = Object.entries(options.sha256).filter(([, hash]) => hash !== undefined);
  if (arches.length === 0) throw invalid('--sha256', 'needs at least one arch=<hex>');
  for (const [arch, hash] of arches) {
    if (arch !== 'amd64' && arch !== 'arm64')
      throw invalid('--sha256', `names unknown architecture ${arch}`);
    if (!hexPattern.test(hash!))
      throw invalid('--sha256', `for ${arch} must be 64 lower-case hex digits`);
  }
  for (const name of options.plugins?.privileged ?? [])
    if (!idPattern.test(name)) throw invalid('--privileged-plugins', 'must name plugins by letters, digits and . _ -');
  const jwk = options.joinEncryptionJwk;
  if (
    jwk.kty !== 'EC' ||
    jwk.crv !== 'P-256' ||
    !base64urlPattern.test(jwk.x) ||
    !base64urlPattern.test(jwk.y)
  )
    throw invalid('join encryption key', 'must be a P-256 public JWK');
  return {
    ...options,
    gatewayUrl: checkUrl('--gateway-url', options.gatewayUrl),
    downloadsBase: checkUrl('the downloads URL', options.downloadsBase),
  };
}

/** config.toml exactly as daemon/internal/config parses it: required keys, basic strings. */
export function renderBcdConfig(
  options: Pick<
    InstallScriptOptions,
    'gatewayUrl' | 'siteId' | 'servingCaSpkiPin' | 'joinSigningKeyPin' | 'joinEncryptionKeyPin'
  >,
): string {
  return [
    '# Written by the better-compute install script. bcd refuses unknown keys.',
    `gateway_url = "${options.gatewayUrl}"`,
    `site = "${options.siteId}"`,
    `serving_ca_spki_pin = "${options.servingCaSpkiPin}"`,
    `join_signing_key_pin = "${options.joinSigningKeyPin}"`,
    `join_encryption_key_pin = "${options.joinEncryptionKeyPin}"`,
    '',
  ].join('\n');
}

/** Where plugins live (root-owned, 0755: each runs under its own uid and must reach its binary). */
export const bcdPluginsDir = '/usr/local/lib/bcd/plugins';

/**
 * The [plugins] section of a node that runs bcx plugins: their directory and a child of bcd's own delegated cgroup
 * (the drop-in's Delegate=yes, with bcd itself in the "main" subgroup), where each plugin gets its own limits.
 */
export function renderBcdPluginsSection(plugins: { privileged?: readonly string[] }): string {
  return [
    '[plugins]',
    `dir = "${bcdPluginsDir}"`,
    'cgroup = "/sys/fs/cgroup/system.slice/bcd.service/plugins"',
    ...(plugins.privileged?.length ? [`privileged = "${plugins.privileged.join(',')}"`] : []),
    '',
  ].join('\n');
}

/**
 * The drop-in (bcd.service.d/plugins.conf) for a node with [plugins]: bcd starts each plugin under its own uid
 * (CAP_SETUID/CAP_SETGID; CAP_KILL to stop it) in its own child of bcd's delegated cgroup (memory_max, pids_max).
 * CapabilityBoundingSet adds to the unit's; nothing else is loosened.
 */
export const bcdPluginsDropIn = `[Service]
# bcx plugins ([plugins] in /etc/bcd/config.toml): their own uids, their own cgroups.
CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_KILL
Delegate=yes
DelegateSubgroup=main
ProtectControlGroups=no
`;

/** Added for plugins named in plugins.privileged (a runtime plugin makes namespaces and mounts). */
export const bcdPrivilegedPluginsDropIn = `# plugins.privileged in /etc/bcd/config.toml: runtime plugins that make namespaces (Kata).
RestrictNamespaces=no
`;

/** The systemd unit, with the §6 hardening. Until the v0.4 helper split, bcd runs as root. */
export const bcdServiceUnit = `[Unit]
Description=better-compute node agent (bcd)
Documentation=https://github.com/better-compute/better-compute
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
ExecStart=/usr/local/bin/bcd node --config /etc/bcd/config.toml
Restart=always
RestartSec=5s
UMask=0077
StateDirectory=bcd
StateDirectoryMode=0700
RuntimeDirectory=bcd
RuntimeDirectoryMode=0700
ConfigurationDirectory=bcd
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=-/etc/cdi -/var/run/cdi
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
CapabilityBoundingSet=CAP_SYS_BOOT CAP_SYS_ADMIN CAP_SYS_RAWIO CAP_DAC_READ_SEARCH CAP_NET_ADMIN CAP_CHOWN CAP_FOWNER CAP_DAC_OVERRIDE

[Install]
WantedBy=multi-user.target
`;

/** Renders the install script. Throws `INVALID_INPUT` when an option is unsafe or malformed. */
export function renderInstallScript(input: InstallScriptOptions): string {
  const options = checkInstallScriptOptions(input);
  const jwk = JSON.stringify({
    kty: 'EC',
    crv: 'P-256',
    x: options.joinEncryptionJwk.x,
    y: options.joinEncryptionJwk.y,
  });
  const sums = (['amd64', 'arm64'] as const)
    .map((arch) => `SHA256_${arch}='${options.sha256[arch] ?? ''}'`)
    .join('\n');
  return `#!/bin/sh
# better-compute: install bcd and join pool ${options.poolId} at site ${options.siteId}.
# Generated${options.generatedAt ? ` ${options.generatedAt}` : ''}${options.generator ? ` by ${options.generator}` : ''}.
#
# Run as root. The join token is read from BCD_JOIN_TOKEN or standard input, never from arguments:
#   BCD_JOIN_TOKEN=bcjt_... sh install-bcd.sh
#   sh install-bcd.sh < token-file
# Download the script first; piping it into sh would leave no standard input for the token.
# Without a token on an already configured host, the script upgrades bcd in place.
set -eu
umask 077

BCD_VERSION='${options.version}'
DOWNLOADS='${options.downloadsBase}'
${sums}

fail() {
  printf 'bcd install: %s\\n' "$1" >&2
  exit "\${2:-1}"
}

[ "$(uname -s)" = Linux ] || fail 'bcd runs on Linux only'
[ "$(id -u)" -eq 0 ] || fail 'run this script as root'
command -v systemctl >/dev/null 2>&1 || fail 'systemd is required'
command -v sha256sum >/dev/null 2>&1 || fail 'sha256sum is required'

case "$(uname -m)" in
  x86_64 | amd64) ARCH=amd64; SHA256=$SHA256_amd64 ;;
  aarch64 | arm64) ARCH=arm64; SHA256=$SHA256_arm64 ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac
[ -n "$SHA256" ] || fail "this script carries no bcd build for $ARCH"

TOKEN=
if [ -n "\${BCD_JOIN_TOKEN:-}" ]; then
  TOKEN=$BCD_JOIN_TOKEN
elif [ ! -t 0 ]; then
  IFS= read -r TOKEN || [ -n "$TOKEN" ] || TOKEN=
fi
unset BCD_JOIN_TOKEN
case "$TOKEN" in
  '') [ -f /etc/bcd/config.toml ] || fail 'no join token: set BCD_JOIN_TOKEN or pass the token on standard input' 2 ;;
  bcjt_*.*) ;;
  *) fail 'that is not a join token (bcjt_...)' 2 ;;
esac

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM
URL="$DOWNLOADS/bcd/$BCD_VERSION/linux-$ARCH"
if command -v curl >/dev/null 2>&1; then
  curl -fsS --proto '=https' --tlsv1.2 --retry 3 -o "$TMP/bcd" "$URL" || fail "download failed: $URL"
elif command -v wget >/dev/null 2>&1; then
  wget -q --https-only -O "$TMP/bcd" "$URL" || fail "download failed: $URL"
else
  fail 'curl or wget is required'
fi
printf '%s  %s\\n' "$SHA256" "$TMP/bcd" | sha256sum -c - >/dev/null 2>&1 || fail 'the downloaded bcd does not match its pinned SHA-256'

install -d -m 0700 /etc/bcd /var/lib/bcd
install -d -m 0755 /etc/cdi${options.plugins ? ` ${bcdPluginsDir}` : ''}
# Copy beside the target, then rename: the swap is atomic even while bcd runs.
cp "$TMP/bcd" /usr/local/bin/bcd.new
chmod 0755 /usr/local/bin/bcd.new
mv -f /usr/local/bin/bcd.new /usr/local/bin/bcd

cat > /etc/bcd/config.toml.new <<'BCD_CONFIG'
${renderBcdConfig(options)}BCD_CONFIG
if [ -f /etc/bcd/config.toml ] && grep -q '^\\[' /etc/bcd/config.toml; then
  # An upgrade keeps the sections the operator configured ([plugins], [boot], [imds]...).
  sed -n '/^\\[/,$p' /etc/bcd/config.toml >> /etc/bcd/config.toml.new
fi
${
  options.plugins
    ? `# This node runs bcx plugins: a [plugins] section unless the operator's config already has one.
if ! grep -q '^\\[plugins\\]' /etc/bcd/config.toml.new; then
  cat >> /etc/bcd/config.toml.new <<'BCD_PLUGINS'
${renderBcdPluginsSection(options.plugins)}BCD_PLUGINS
fi
`
    : ''
}chmod 0600 /etc/bcd/config.toml.new
mv -f /etc/bcd/config.toml.new /etc/bcd/config.toml

cat > /etc/bcd/join-encryption.jwk.new <<'BCD_JWK'
${jwk}
BCD_JWK
chmod 0644 /etc/bcd/join-encryption.jwk.new
mv -f /etc/bcd/join-encryption.jwk.new /etc/bcd/join-encryption.jwk

cat > /etc/systemd/system/bcd.service.new <<'BCD_UNIT'
${bcdServiceUnit}BCD_UNIT
chmod 0644 /etc/systemd/system/bcd.service.new
mv -f /etc/systemd/system/bcd.service.new /etc/systemd/system/bcd.service
# bcx plugins: the drop-in exactly when config.toml has a [plugins] section (others keep the tighter unit).
install -d -m 0755 /etc/systemd/system/bcd.service.d
if grep -q '^\\[plugins\\]' /etc/bcd/config.toml; then
  cat > /etc/systemd/system/bcd.service.d/plugins.conf.new <<'BCD_DROPIN'
${bcdPluginsDropIn}BCD_DROPIN
  if sed -n '/^\\[plugins\\]/,/^\\[[a-z]/p' /etc/bcd/config.toml | grep -Eq '^privileged *= *"[^"]'; then
    cat >> /etc/systemd/system/bcd.service.d/plugins.conf.new <<'BCD_DROPIN'
${bcdPrivilegedPluginsDropIn}BCD_DROPIN
  fi
  chmod 0644 /etc/systemd/system/bcd.service.d/plugins.conf.new
  mv -f /etc/systemd/system/bcd.service.d/plugins.conf.new /etc/systemd/system/bcd.service.d/plugins.conf
else
  rm -f /etc/systemd/system/bcd.service.d/plugins.conf
fi
systemctl daemon-reload

/usr/local/bin/bcd doctor --config /etc/bcd/config.toml >/dev/null 2>&1 ||
  printf 'bcd install: warning: bcd doctor reported a problem; run it for details\\n' >&2

if [ -n "$TOKEN" ]; then
  # printf is a shell builtin: the token never appears in a process listing.
  printf '%s\\n' "$TOKEN" | /usr/local/bin/bcd join --config /etc/bcd/config.toml || fail 'bcd join failed'
  TOKEN=
  systemctl enable --now bcd.service
  printf 'bcd %s joined pool ${options.poolId} and is running.\\n' "$BCD_VERSION"
else
  systemctl restart bcd.service
  printf 'bcd upgraded to %s and restarted.\\n' "$BCD_VERSION"
fi
`;
}
