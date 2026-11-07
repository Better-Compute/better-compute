import { RiCloudLine, RiMoneyDollarCircleLine, RiShieldCheckLine } from 'react-icons/ri';
import type { AdminModule } from '@/lib/modules';
import { providerAttention, providersHref } from './attention';
import { currentProviderParts } from './live';
import { ProvidersStatus } from './status';

/**
 * Provider accounts (DigitalOcean P9): the cloud accounts compute provisions on, a read-only check of each
 * credential, the providers' findings (DigitalOcean's security scan) and billing leaks, all from the live API.
 */
export const providersModule: AdminModule = {
  id: 'providers',
  title: 'Providers',
  nav: [
    {
      href: providersHref,
      label: 'Provider accounts',
      icon: RiCloudLine,
      group: 'Operations',
      keywords: ['digitalocean', 'aws', 'gcp', 'cloud', 'credentials', 'scopes', 'security', 'leaks', 'billing'],
      description: 'Cloud accounts: credential checks, provider findings, billed hours compute did not meter',
    },
  ],
  widgets: [],
  status: [ProvidersStatus],
  commands: [
    { id: 'providers.findings', label: 'Provider security findings', group: 'Operations', icon: RiShieldCheckLine, href: providersHref, keywords: ['digitalocean', 'scan', 'posture'] },
    { id: 'providers.leaks', label: 'Billing leaks', group: 'Operations', icon: RiMoneyDollarCircleLine, href: providersHref, keywords: ['unmetered', 'invoice', 'drift', 'cost'] },
  ],
  // Live only: the simulation has no provider accounts.
  attention: (now, _scope, context) => (context.source === 'live' ? providerAttention(currentProviderParts(), now) : []),
};
