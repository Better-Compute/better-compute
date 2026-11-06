import { ComputeError, type ImageRef } from '@better-compute/core';

type Arch = 'x86_64' | 'arm64';

const ubuntuArch = (arch: Arch) => (arch === 'arm64' ? 'arm64' : 'amd64');

/**
 * Image aliases (AD7), expanded per instance architecture to the public SSM parameter EC2 resolves
 * at launch (`resolve:ssm:`). Paths per the AWS program plan, Appendix C.
 */
export const imageAliases: Readonly<Record<string, (arch: Arch) => string>> = {
  'ubuntu-24.04': (arch) =>
    `/aws/service/canonical/ubuntu/server/24.04/stable/current/${ubuntuArch(arch)}/hvm/ebs-gp3/ami-id`,
  'ubuntu-22.04': (arch) =>
    `/aws/service/canonical/ubuntu/server/22.04/stable/current/${ubuntuArch(arch)}/hvm/ebs-gp2/ami-id`,
  al2023: (arch) => `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-${arch}`,
  'dlami-gpu': (arch) =>
    `/aws/service/deeplearning/ami/${arch}/base-oss-nvidia-driver-gpu-ubuntu-22.04/latest/ami-id`,
};

/** The root device name of an alias's AMI family. */
const aliasRootDevice: Readonly<Record<string, string>> = {
  'ubuntu-24.04': '/dev/sda1',
  'ubuntu-22.04': '/dev/sda1',
  al2023: '/dev/xvda',
  'dlami-gpu': '/dev/sda1',
};

const eksAlias = /^eks-al2023-(1\.\d{2})$/;
const amiPattern = /^ami-[0-9a-f]{8,17}$/;
const ssmPattern = /^resolve:ssm:\/[A-Za-z0-9_./-]{1,1011}(?::\d{1,9})?$/;

function invalid(): ComputeError {
  return new ComputeError(
    'INVALID_INPUT',
    `an AWS image is ami-…, resolve:ssm:<parameter>, or one of ${[...Object.keys(imageAliases), 'eks-al2023-<k8s>'].join(', ')}`,
    undefined,
    { provider: 'aws', reason: 'image' },
  );
}

/** `ami-…` and `resolve:ssm:…` pass through; aliases expand per arch; anything else is INVALID_INPUT. */
export function resolveImage(image: ImageRef, arch: Arch): string {
  if (typeof image !== 'string') throw invalid();
  if (amiPattern.test(image)) return image;
  if (ssmPattern.test(image) && !image.includes('..')) return image;
  const alias = imageAliases[image];
  if (alias && Object.hasOwn(imageAliases, image)) return `resolve:ssm:${alias(arch)}`;
  const eks = eksAlias.exec(image);
  if (eks)
    return `resolve:ssm:/aws/service/eks/optimized-ami/${eks[1]}/amazon-linux-2023/${arch}/standard/recommended/image_id`;
  throw invalid();
}

/** The alias's fixed root device name; undefined for raw `ami-…` and `resolve:ssm:…` images. */
export function aliasRootDeviceOf(image: ImageRef): string | undefined {
  if (Object.hasOwn(aliasRootDevice, image)) return aliasRootDevice[image];
  if (eksAlias.test(image)) return '/dev/xvda';
  return undefined;
}

/** The login user of an image: Ubuntu and DLAMI → ubuntu; Amazon Linux, EKS and anything else → ec2-user. */
export function sshUserOf(image: ImageRef): string {
  if (image.startsWith('ubuntu-') || image.startsWith('dlami-')) return 'ubuntu';
  if (
    image.includes('/canonical/ubuntu/') ||
    image.includes('ubuntu-22.04') ||
    image.includes('ubuntu-24.04')
  )
    return 'ubuntu';
  return 'ec2-user';
}
