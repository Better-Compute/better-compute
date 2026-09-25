import { isIP } from 'node:net';
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

/** The bcx plugins a release ships and the downloads route serves (server downloadArtifact's products). */
export const bcxPluginNames = ['bcx-ipmi'] as const;
export type BcxPluginName = (typeof bcxPluginNames)[number];

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
  /**
   * bcx plugins the script installs from the release (`{downloadsBase}/{name}/{version}/linux-{arch}`, a tar.gz):
   * each archive is checked against its digest from the signed release manifest, only the plugin's own regular
   * file is taken from it, and its binary digest becomes its line in the plugins' `pins` file.
   */
  pluginInstalls?: readonly { name: BcxPluginName; sha256: Partial<Record<BcdArch, string>> }[];
  /**
   * (review 7 M2) Hex SHA-256 of the deployment's approver set (`better-compute pki trust-version`): bcd takes only
   * that set as its first, and refuses destructive commands until it has it.
   */
  approverSetSha256?: string;
  /**
   * bcd self-update (PLAN.md §6): the release keys' pins and how many must have signed, as an [update] section
   * (without pins bcd refuses every self-update).
   */
  update?: {
    releasePins: readonly string[];
    threshold?: number;
    /** The release floor (the release sequence bcd never goes below, beside its own embedded one and its state). */
    sequence?: number;
  };
  /**
   * A site agent's BMC networks (CIDRs): site.httpProxy never reaches into them, whatever the control plane asks
   * ([site] bmc_networks; local config, so the control plane cannot loosen it).
   */
  bmcNetworks?: readonly string[];
  /**
   * The WebSocket fallback (PLAN.md §7.1) for networks whose TLS-inspecting proxies break mTLS: bcd dials `url`
   * (wss://…/v1/session) instead, proving its identity inside; `proxyCaPem` is the proxy's CA, trusted for the TLS
   * connection only; `audience` the gateway's public host (default: the URL's).
   */
  websocket?: { url: string; audience?: string; proxyCaPem?: string };
  /**
   * Privilege separation (bcd 28dc2ae): `bcd node` runs as the unprivileged `bcd` user and asks a root
   * `bcd helper` (its own unit, on a unix socket) for typed privileged operations, self-update's swap included (bcd
   * 2d67b25: the slots move to root's /usr/local/lib/bcd).
   */
  unprivileged?: boolean;
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

/** One or more PEM certificates and nothing else (so the file can be embedded in the script verbatim). */
const certificatesOnly = /^(-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE-----\n)+$/;

/** Where the install script writes the WebSocket proxy's CA. */
export const bcdProxyCaPath = '/etc/bcd/websocket-proxy-ca.pem';

/**
 * The [helper] section of an unprivileged node: the helper's socket and the account `bcd node` runs as. The socket
 * lives in the helper's own root-owned runtime directory, not in /run/bcd: bcd owns that one, and root chmods and
 * chowns the socket by path after binding it, which a bcd-writable directory would let bcd redirect with a symlink.
 */
export const bcdHelperSection = ['[helper]', 'socket = "/run/bcd-helper/helper.sock"', 'user = "bcd"', ''].join('\n');

/** The root helper's unit: typed privileged operations for `bcd node` (peer checked by uid, gid and executable). */
export const bcdHelperUnit = `[Unit]
Description=better-compute node agent privileged helper (bcd helper)
Documentation=https://github.com/better-compute/better-compute
Before=bcd.service

[Service]
Type=simple
ExecStart=/usr/local/bin/bcd helper --config /etc/bcd/config.toml
Restart=always
RestartSec=2s
UMask=0077
RuntimeDirectory=bcd-helper
RuntimeDirectoryMode=0755

[Install]
WantedBy=multi-user.target
`;

/**
 * The drop-in (bcd.service.d/unprivileged.conf) of a node with [helper]: `bcd node` as the `bcd` user (systemd
 * chowns its state and runtime directories to it), after the helper. The script adds the libvirt group on VPS hosts
 * that have it.
 */
export const bcdUnprivilegedDropIn = `[Unit]
Requires=bcd-helper.service
After=bcd-helper.service

[Service]
User=bcd
Group=bcd
SupplementaryGroups=systemd-journal adm
`;

/** The [websocket] section: the fallback URL, the proxy CA file, the audience. */
export function renderBcdWebSocketSection(ws: { url: string; audience?: string; proxyCaPem?: string }): string {
  return [
    '[websocket]',
    `url = "${ws.url}"`,
    ...(ws.proxyCaPem ? [`proxy_ca_file = "${bcdProxyCaPath}"`] : []),
    ...(ws.audience ? [`audience = "${ws.audience}"`] : []),
    '',
  ].join('\n');
}

/** `10.20.0.0/16`, `fd00::/64`: an address and a prefix length that fits it. */
function isCidr(value: string): boolean {
  const match = /^([0-9A-Fa-f:.]+)\/(\d{1,3})$/.exec(value);
  if (!match) return false;
  const family = isIP(match[1]!);
  const bits = Number(match[2]);
  return family === 4 ? bits <= 32 : family === 6 ? bits <= 128 : false;
}

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
  if (options.approverSetSha256 !== undefined && !hexPattern.test(options.approverSetSha256))
    throw invalid('--approver-set-sha256', 'must be 64 lower-case hex digits (pki trust-version prints it)');
  if (options.update) {
    const pins = new Set(options.update.releasePins);
    if (pins.size === 0 || ![...pins].every((pin) => pinPattern.test(pin)))
      throw invalid('--release-pins', 'must be sha256/<base64 of 32 bytes> pins, comma-separated');
    // bcd counts distinct pins.
    const threshold = options.update.threshold ?? 1;
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > pins.size)
      throw invalid('--release-threshold', `must be from 1 to the ${pins.size} distinct release pin(s)`);
    const sequence = options.update.sequence;
    if (sequence !== undefined && !(Number.isSafeInteger(sequence) && sequence >= 1))
      throw invalid('--release-sequence', 'must be a whole number of at least 1');
  }
  if (options.websocket) {
    const ws = options.websocket;
    if (!/^wss:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/.test(ws.url))
      throw invalid('--websocket-url', 'must be a wss:// URL of letters, digits and . - _ ~ /');
    if (ws.audience !== undefined && !/^[A-Za-z0-9.-]{1,253}$/.test(ws.audience))
      throw invalid('--websocket-audience', 'must be a host name');
    if (ws.proxyCaPem !== undefined && !certificatesOnly.test(ws.proxyCaPem))
      throw invalid('--proxy-ca-file', 'must hold PEM certificates and nothing else');
  }
  for (const cidr of options.bmcNetworks ?? []) if (!isCidr(cidr)) throw invalid('--bmc-networks', `has ${JSON.stringify(cidr)}, not a CIDR`);
  if (options.bmcNetworks && options.bmcNetworks.length === 0) throw invalid('--bmc-networks', 'lists no network');
  for (const name of options.plugins?.privileged ?? [])
    if (!idPattern.test(name)) throw invalid('--privileged-plugins', 'must name plugins by letters, digits and . _ -');
  for (const plugin of options.pluginInstalls ?? []) {
    if (!(bcxPluginNames as readonly string[]).includes(plugin.name))
      throw invalid('--install-plugins', `names ${JSON.stringify(plugin.name)}, not one of ${bcxPluginNames.join(', ')}`);
    const sums = Object.entries(plugin.sha256);
    if (!sums.length || sums.some(([arch, sum]) => !['amd64', 'arm64'].includes(arch) || !hexPattern.test(sum ?? '')))
      throw invalid('--install-plugins', `needs a lowercase hex SHA-256 per architecture for ${plugin.name}`);
  }
  if (options.pluginInstalls?.length && !options.plugins)
    throw invalid('--install-plugins', 'needs the node prepared for plugins (--plugins)');
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
    'gatewayUrl' | 'siteId' | 'servingCaSpkiPin' | 'joinSigningKeyPin' | 'joinEncryptionKeyPin' | 'approverSetSha256'
  >,
): string {
  return [
    '# Written by the better-compute install script. bcd refuses unknown keys.',
    `gateway_url = "${options.gatewayUrl}"`,
    `site = "${options.siteId}"`,
    `serving_ca_spki_pin = "${options.servingCaSpkiPin}"`,
    `join_signing_key_pin = "${options.joinSigningKeyPin}"`,
    `join_encryption_key_pin = "${options.joinEncryptionKeyPin}"`,
    ...(options.approverSetSha256 ? [`approver_set_sha256 = "${options.approverSetSha256}"`] : []),
    '',
  ].join('\n');
}

/** The [site] section of a site agent: the BMC networks site.httpProxy never reaches. */
export function renderBcdSiteSection(bmcNetworks: readonly string[]): string {
  return ['[site]', `bmc_networks = "${bmcNetworks.join(',')}"`, ''].join('\n');
}

/**
 * The [update] section: bcd self-updates only to releases signed by `threshold` of these keys, and never to one
 * below `sequence` (its floor is the highest of this, its own state and the sequence built into it).
 */
export function renderBcdUpdateSection(update: {
  releasePins: readonly string[];
  threshold?: number;
  sequence?: number;
}): string {
  return [
    '[update]',
    `release_pins = "${[...new Set(update.releasePins)].join(',')}"`,
    `release_threshold = ${update.threshold ?? 1}`,
    ...(update.sequence === undefined ? [] : [`release_sequence = ${update.sequence}`]),
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

/**
 * Added for plugins named in plugins.privileged: a runtime plugin (Kata) runs VMs as root, so it needs namespaces,
 * vsock, the vhost modules and close to root's capabilities (VM memory locking, device nodes, virtiofsd's ptrace).
 * Only those plugins get them: confined plugins drop every capability at setuid (their own uid, NNP, seccomp).
 */
export const bcdPrivilegedPluginsDropIn = `# plugins.privileged in /etc/bcd/config.toml: runtime plugins that run VMs as root (Kata).
CapabilityBoundingSet=CAP_MKNOD CAP_SYS_RESOURCE CAP_IPC_LOCK CAP_SYS_NICE CAP_NET_RAW CAP_SYS_CHROOT CAP_FSETID CAP_SETPCAP CAP_SYS_PTRACE
RestrictNamespaces=no
RestrictAddressFamilies=AF_VSOCK AF_PACKET
ProtectKernelModules=no
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

/**
 * The script's plugin installs: per plugin, its archive from the downloads route, checked against the signed digest
 * for this architecture; only the plugin's own member, a regular file with no path, is extracted (no links, no
 * other member, nothing with / or ..); installed 0755 beside the others; its binary digest replaces its line in
 * `pins` (bcd refuses a plugin whose digest is not its pin). Other lines of `pins` are the operator's and stay.
 */
export function renderPluginInstalls(
  plugins: readonly { name: BcxPluginName; sha256: Partial<Record<BcdArch, string>> }[],
): string {
  const calls = plugins
    .map(
      (plugin) => `case "$ARCH" in
  amd64) PLUGIN_SHA256='${plugin.sha256.amd64 ?? ''}' ;;
  arm64) PLUGIN_SHA256='${plugin.sha256.arm64 ?? ''}' ;;
esac
install_plugin '${plugin.name}' "$PLUGIN_SHA256"`,
    )
    .join('\n');
  return `
# bcx plugins from this release, pinned by the signed release manifest.
install_plugin() {
  name=$1
  sum=$2
  [ -n "$sum" ] || fail "this script carries no $name build for $ARCH"
  url="$DOWNLOADS/$name/$BCD_VERSION/linux-$ARCH"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --proto '=https' --tlsv1.2 --retry 3 -o "$TMP/$name.tar.gz" "$url" || fail "download failed: $url"
  else
    wget -q --https-only -O "$TMP/$name.tar.gz" "$url" || fail "download failed: $url"
  fi
  printf '%s  %s\\n' "$sum" "$TMP/$name.tar.gz" | sha256sum -c - >/dev/null 2>&1 ||
    fail "the downloaded $name does not match its pinned SHA-256"
  # Nothing with a path or a parent reference, and the plugin's own member a regular file (not a link).
  tar -tzf "$TMP/$name.tar.gz" > "$TMP/$name.list" || fail "$name: not a tar.gz archive"
  if grep -Eq '(^/|(^|/)\\.\\.(/|$))' "$TMP/$name.list"; then fail "$name: the archive names paths outside it"; fi
  grep -qx "$name" "$TMP/$name.list" || fail "$name: the archive has no $name"
  case "$(tar -tvzf "$TMP/$name.tar.gz" "$name" | head -n 1)" in
    -*) ;;
    *) fail "$name: its member is not a regular file" ;;
  esac
  mkdir "$TMP/$name.x"
  tar -xzf "$TMP/$name.tar.gz" -C "$TMP/$name.x" "$name" || fail "$name: extracting it failed"
  [ -f "$TMP/$name.x/$name" ] && [ ! -L "$TMP/$name.x/$name" ] || fail "$name: not a regular file"
  cp "$TMP/$name.x/$name" "${bcdPluginsDir}/$name.new"
  chmod 0755 "${bcdPluginsDir}/$name.new"
  mv -f "${bcdPluginsDir}/$name.new" "${bcdPluginsDir}/$name"
  bin=$(sha256sum "${bcdPluginsDir}/$name" | cut -d ' ' -f 1)
  # Its pin replaces its old line; the operator's other lines stay.
  touch "${bcdPluginsDir}/pins"
  { grep -v " [ *]$name\$" "${bcdPluginsDir}/pins" || true; printf '%s  %s\\n' "$bin" "$name"; } > "${bcdPluginsDir}/pins.new"
  chmod 0644 "${bcdPluginsDir}/pins.new"
  mv -f "${bcdPluginsDir}/pins.new" "${bcdPluginsDir}/pins"
}
${calls}
`;
}

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
install -d -m 0755 /etc/cdi${options.plugins ? ` /usr/local/lib/bcd ${bcdPluginsDir}` : ''}
# Copy beside the target, then rename: the swap is atomic even while bcd runs.
cp "$TMP/bcd" /usr/local/bin/bcd.new
chmod 0755 /usr/local/bin/bcd.new
mv -f /usr/local/bin/bcd.new /usr/local/bin/bcd
${options.pluginInstalls?.length ? renderPluginInstalls(options.pluginInstalls) : ''}
cat > /etc/bcd/config.toml.new <<'BCD_CONFIG'
${renderBcdConfig(options)}BCD_CONFIG
${
  options.approverSetSha256
    ? ''
    : `# An upgrade keeps the approver-set pin this node was installed with (a script without --approver-set-sha256
# must not drop it).
if [ -f /etc/bcd/config.toml ]; then
  sed -n '/^[[:space:]]*\\[/q; /^[[:space:]]*approver_set_sha256[[:space:]]*=/p' /etc/bcd/config.toml >> /etc/bcd/config.toml.new
fi
`
}if [ -f /etc/bcd/config.toml ] && grep -q '^[[:space:]]*\\[' /etc/bcd/config.toml; then
  # An upgrade keeps the sections the operator configured ([plugins], [boot], [imds]..., headers indented or not).
  sed -n '/^[[:space:]]*\\[/,$p' /etc/bcd/config.toml >> /etc/bcd/config.toml.new
fi
${
  options.unprivileged
    ? `# Privilege separation: a [helper] section unless the operator's config already has one.
if ! grep -Eq '^[[:space:]]*\\[[[:space:]]*helper[[:space:]]*\\]' /etc/bcd/config.toml.new; then
  cat >> /etc/bcd/config.toml.new <<'BCD_HELPER'
${bcdHelperSection}BCD_HELPER
fi
`
    : ''
}${
  options.websocket
    ? `${
        options.websocket.proxyCaPem
          ? `# The TLS-inspecting proxy's CA (trusted for the WebSocket's TLS only; identity is proven inside).
cat > ${bcdProxyCaPath}.new <<'BCD_PROXY_CA'
${options.websocket.proxyCaPem}BCD_PROXY_CA
chmod 0644 ${bcdProxyCaPath}.new
mv -f ${bcdProxyCaPath}.new ${bcdProxyCaPath}
`
          : ''
      }# The WebSocket fallback: a [websocket] section unless the operator's config already has one.
if ! grep -Eq '^[[:space:]]*\\[[[:space:]]*websocket[[:space:]]*\\]' /etc/bcd/config.toml.new; then
  cat >> /etc/bcd/config.toml.new <<'BCD_WEBSOCKET'
${renderBcdWebSocketSection(options.websocket)}BCD_WEBSOCKET
else
  printf 'bcd install: note: config.toml already has a [websocket] section; --websocket-url was not applied to it\\n' >&2
fi
`
    : ''
}${
  options.bmcNetworks
    ? `# A site agent's BMC networks: a [site] section unless the operator's config already has one.
if ! grep -Eq '^[[:space:]]*\\[[[:space:]]*site[[:space:]]*\\]' /etc/bcd/config.toml.new; then
  cat >> /etc/bcd/config.toml.new <<'BCD_SITE'
${renderBcdSiteSection(options.bmcNetworks)}BCD_SITE
else
  printf 'bcd install: note: config.toml already has a [site] section; --bmc-networks was not applied to it\\n' >&2
fi
`
    : ''
}${
  options.update
    ? `# bcd self-update: an [update] section unless the operator's config already has one.
if ! grep -Eq '^[[:space:]]*\\[[[:space:]]*update[[:space:]]*\\]' /etc/bcd/config.toml.new; then
  cat >> /etc/bcd/config.toml.new <<'BCD_UPDATE'
${renderBcdUpdateSection(options.update)}BCD_UPDATE
else
  printf 'bcd install: note: config.toml already has an [update] section; --release-pins/--release-sequence were not applied to it\\n' >&2
fi
`
    : ''
}${
  options.plugins
    ? `# This node runs bcx plugins: a [plugins] section unless the operator's config already has one.
if ! grep -Eq '^[[:space:]]*\\[[[:space:]]*plugins[[:space:]]*\\]' /etc/bcd/config.toml.new; then
  cat >> /etc/bcd/config.toml.new <<'BCD_PLUGINS'
${renderBcdPluginsSection(options.plugins)}BCD_PLUGINS
${
  options.plugins.privileged?.length
    ? `else
  printf 'bcd install: note: config.toml already has a [plugins] section; --privileged-plugins was not applied to it\\n' >&2
`
    : ''
}fi
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
if grep -Eq '^[[:space:]]*\\[[[:space:]]*plugins[[:space:]]*\\]' /etc/bcd/config.toml; then
  cat > /etc/systemd/system/bcd.service.d/plugins.conf.new <<'BCD_DROPIN'
${bcdPluginsDropIn}BCD_DROPIN
  if sed -n '/^[[:space:]]*\\[[[:space:]]*plugins[[:space:]]*\\]/,/^[[:space:]]*\\[[[:space:]]*[a-z]/p' /etc/bcd/config.toml |
    grep -Eq '^[[:space:]]*privileged[[:space:]]*=[[:space:]]*"[^"[:space:]]'; then
    cat >> /etc/systemd/system/bcd.service.d/plugins.conf.new <<'BCD_DROPIN'
${bcdPrivilegedPluginsDropIn}BCD_DROPIN
  fi
  chmod 0644 /etc/systemd/system/bcd.service.d/plugins.conf.new
  mv -f /etc/systemd/system/bcd.service.d/plugins.conf.new /etc/systemd/system/bcd.service.d/plugins.conf
else
  rm -f /etc/systemd/system/bcd.service.d/plugins.conf
fi
# Privilege separation exactly when config.toml has a [helper] section (an upgrade keeps the node's mode).
BCD_HELPER=
if grep -Eq '^[[:space:]]*\\[[[:space:]]*helper[[:space:]]*\\]' /etc/bcd/config.toml; then
  BCD_HELPER=1
  if ! id -u bcd >/dev/null 2>&1; then
    if command -v useradd >/dev/null 2>&1; then
      useradd --system --no-create-home --home-dir /var/lib/bcd --shell /usr/sbin/nologin bcd
    else
      adduser -S -D -H -h /var/lib/bcd -s /sbin/nologin bcd
    fi
  fi
  cat > /etc/systemd/system/bcd-helper.service.new <<'BCD_HELPER_UNIT'
${bcdHelperUnit}BCD_HELPER_UNIT
  chmod 0644 /etc/systemd/system/bcd-helper.service.new
  mv -f /etc/systemd/system/bcd-helper.service.new /etc/systemd/system/bcd-helper.service
  cat > /etc/systemd/system/bcd.service.d/unprivileged.conf.new <<'BCD_UNPRIVILEGED'
${bcdUnprivilegedDropIn}BCD_UNPRIVILEGED
  # VPS hosts: the libvirt socket's group, when there is one.
  if getent group libvirt >/dev/null 2>&1; then
    printf 'SupplementaryGroups=libvirt\\n' >> /etc/systemd/system/bcd.service.d/unprivileged.conf.new
  fi
  chmod 0644 /etc/systemd/system/bcd.service.d/unprivileged.conf.new
  mv -f /etc/systemd/system/bcd.service.d/unprivileged.conf.new /etc/systemd/system/bcd.service.d/unprivileged.conf
  # The helper keeps the self-update slots here, root's; bcd node must be able to run what the entrypoint links to
  # (the helper's UMask would make the directory 0700).
  install -d -m 0755 /usr/local/lib/bcd
  chmod 0755 /usr/local/lib/bcd
  # bcd node reads its config as the bcd group; nothing else of /etc/bcd becomes readable to it.
  chgrp bcd /etc/bcd /etc/bcd/config.toml
  chmod 0750 /etc/bcd
  chmod 0640 /etc/bcd/config.toml
else
  rm -f /etc/systemd/system/bcd.service.d/unprivileged.conf
fi
systemctl daemon-reload

/usr/local/bin/bcd doctor --config /etc/bcd/config.toml >/dev/null 2>&1 ||
  printf 'bcd install: warning: bcd doctor reported a problem; run it for details\\n' >&2

if [ -n "$TOKEN" ]; then
  # printf is a shell builtin: the token never appears in a process listing.
  printf '%s\\n' "$TOKEN" | /usr/local/bin/bcd join --config /etc/bcd/config.toml || fail 'bcd join failed'
  TOKEN=
  if [ -n "$BCD_HELPER" ]; then
    # The identity bcd join wrote (as root) belongs to the bcd user; the helper runs first.
    chown -R bcd:bcd /var/lib/bcd
    systemctl enable --now bcd-helper.service
  fi
  systemctl enable --now bcd.service
  printf 'bcd %s joined pool ${options.poolId} and is running.\\n' "$BCD_VERSION"
else
  if [ -n "$BCD_HELPER" ]; then
    chown -R bcd:bcd /var/lib/bcd
    systemctl enable bcd-helper.service
    systemctl restart bcd-helper.service
  fi
  systemctl restart bcd.service
  printf 'bcd upgraded to %s and restarted.\\n' "$BCD_VERSION"
fi
`;
}
