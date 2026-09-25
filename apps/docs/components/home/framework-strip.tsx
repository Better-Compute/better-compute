import type { IconType } from 'react-icons';
import Link from 'next/link';
import { RiArrowRightLine } from 'react-icons/ri';
import {
  SiGooglecloud,
  SiHetzner,
  SiLinux,
  SiNvidia,
  SiPostgresql,
  SiPrometheus,
  SiProxmox,
  SiQemu,
  SiTalos,
  SiUbuntu,
} from 'react-icons/si';
import { TextLink } from '@/components/site/action';
import { Band, gutter } from '@/components/site/frame';
import { StaggerChild, StaggerList } from '@/components/site/motion-text';
import { cx } from '@/utils/cx';

/**
 * What Better Compute works with, each backed by code in the repository:
 * - NVIDIA: NVML GPU naming and `diag.nvml` / `diag.dcgm` command kinds (inventory, metal).
 * - Linux: `bcd` targets Linux servers only (Windows and macOS nodes are a PLAN.md non-goal).
 * - Ubuntu autoinstall and Talos: the §5.6 walkthroughs (tests/extensions/*), written with no edits to the packages.
 * - PostgreSQL: `postgres()` from @better-compute/postgres (PGlite for development and tests).
 * - QEMU/KVM: the `libvirt-kvm` VPS runtime (vps) and the emulated bare-metal site (examples/emulated-site).
 * - Proxmox VE and Hetzner: @better-compute/provider-proxmox and @better-compute/provider-hetzner.
 * - Google Cloud: the `cloud-iid` attestor's instance identity (pki; AWS is supported the same way).
 * - Prometheus: `GET /metrics` from @better-compute/observability.
 */
const targets: [name: string, logo: IconType, role: string, href: string][] = [
  ['NVIDIA', SiNvidia, 'NVML and DCGM', '/docs/guides/nodes/inventory-and-health'],
  ['Linux', SiLinux, 'bcd on every node', '/docs/daemon/install'],
  ['Ubuntu', SiUbuntu, 'autoinstall', '/docs/extending/walkthroughs'],
  ['Talos', SiTalos, 'agentless profile', '/docs/extending/walkthroughs'],
  ['PostgreSQL', SiPostgresql, 'the store', '/docs/operations/database'],
  ['QEMU/KVM', SiQemu, 'libvirt-kvm VPS', '/docs/guides/vps/instances'],
  ['Proxmox VE', SiProxmox, 'VPS provider', '/docs/guides/vps/providers'],
  ['Hetzner', SiHetzner, 'Cloud and Robot', '/docs/guides/vps/providers'],
  ['Google Cloud', SiGooglecloud, 'instance identity', '/docs/guides/nodes/attestation'],
  ['Prometheus', SiPrometheus, 'metrics', '/docs/operations/observability'],
];

const corners = [
  'top-3 left-3 -translate-x-1 -translate-y-1 border-t border-l',
  'top-3 right-3 translate-x-1 -translate-y-1 border-t border-r',
  'bottom-3 left-3 -translate-x-1 translate-y-1 border-b border-l',
  'right-3 bottom-3 translate-x-1 translate-y-1 border-r border-b',
];

/** The hardware, systems, and providers Better Compute runs on, as their own logos (Simple Icons) in one hairline grid. */
export function RunsOnStrip() {
  return (
    <Band aria-label="Runs on">
      <div
        className={cx(
          'flex flex-wrap items-center justify-between gap-3 border-b border-separator-border py-4',
          gutter,
        )}
      >
        <p className="eyebrow">Runs on the hardware and platforms you already have</p>
        <TextLink
          href="/docs/extending"
          trailingIcon={RiArrowRightLine}
          className="text-body-2-medium"
        >
          Add your own
        </TextLink>
      </div>
      <StaggerList className="grid grid-cols-2 gap-px bg-separator-border sm:grid-cols-5 xl:grid-cols-10">
        {targets.map(([name, Logo, role, href]) => (
          <li key={name} className="bg-background-full">
            <StaggerChild>
              <Link
                href={href}
                className="group relative flex h-28 flex-col items-center justify-center gap-2 px-2 text-center transition-colors duration-200 hover:bg-background-secondary-default"
              >
                {/* Corner brackets close in on the logo under the pointer. */}
                {corners.map((corner) => (
                  <span
                    key={corner}
                    aria-hidden
                    className={cx(
                      'absolute size-2.5 border-text-primary opacity-0 transition-[opacity,transform] duration-300 ease-out group-hover:translate-x-0 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:opacity-100',
                      corner,
                    )}
                  />
                ))}
                <Logo
                  className="size-6 text-foreground-icon-secondary transition-[color,transform] duration-300 ease-out group-hover:-translate-y-0.5 group-hover:scale-110 group-hover:text-foreground-icon-primary"
                  aria-hidden
                />
                <span className="flex flex-col items-center gap-0.5">
                  <span className="text-caption-1-medium text-text-secondary transition-colors group-hover:text-text-primary">
                    {name}
                  </span>
                  <span className="text-caption-2-regular text-text-tertiary transition-colors group-hover:text-text-secondary">
                    {role}
                  </span>
                </span>
              </Link>
            </StaggerChild>
          </li>
        ))}
      </StaggerList>
    </Band>
  );
}
