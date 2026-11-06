// What a managed cluster's own Kubernetes API keeps of the access objects the GKE, EKS and DOKS drivers write when they
// mint credentials (namespaces, service accounts, ClusterRoles, ClusterRoleBindings, ValidatingAdmissionPolicies and
// their bindings, TokenRequest tokens), one store per cluster, and what RBAC plus the bound admission policies let a
// minted token do (`can`). The emulators (TokenRequestApi for GKE, EksKubeApi, the DOKS FakeClusterApis) authenticate
// the driver's own token, then hand the request here.

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** One thing a token might do: `verb` on `resource` (`pods`, `serviceaccounts/token`) of `group` in `namespace`. */
export interface KubeAccessRequest {
  verb: string;
  resource: string;
  /** The API group; '' (the core group) when absent. */
  group?: string;
  /** Absent for a cluster-scoped resource. */
  namespace?: string;
}

interface Rule {
  apiGroups?: string[];
  resources?: string[];
  verbs?: string[];
}

const readVerbs = ['get', 'list', 'watch'];
const writeVerbs = ['create', 'delete', 'deletecollection', 'patch', 'update'];

/**
 * The built-in ClusterRoles the drivers bind or aggregate, as upstream Kubernetes defines them (the parts that matter
 * here): `view` reads (no secrets), `edit` adds writes, impersonation of service accounts and TokenRequest, and
 * `cluster-admin` does anything. `view` and `edit` aggregate `system:aggregate-to-*` by label, as upstream does.
 */
export const builtinClusterRoles: Record<string, Json> = {
  'cluster-admin': { metadata: { name: 'cluster-admin' }, rules: [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }] },
  'system:aggregate-to-view': {
    metadata: {
      name: 'system:aggregate-to-view',
      labels: { 'rbac.authorization.k8s.io/aggregate-to-view': 'true' },
    },
    rules: [
      {
        apiGroups: [''],
        resources: [
          'configmaps',
          'endpoints',
          'events',
          'namespaces',
          'nodes',
          'persistentvolumeclaims',
          'pods',
          'pods/log',
          'replicationcontrollers',
          'serviceaccounts',
          'services',
        ],
        verbs: readVerbs,
      },
      { apiGroups: ['apps'], resources: ['daemonsets', 'deployments', 'replicasets', 'statefulsets'], verbs: readVerbs },
      { apiGroups: ['batch'], resources: ['cronjobs', 'jobs'], verbs: readVerbs },
    ],
  },
  'system:aggregate-to-edit': {
    metadata: {
      name: 'system:aggregate-to-edit',
      labels: { 'rbac.authorization.k8s.io/aggregate-to-edit': 'true' },
    },
    rules: [
      { apiGroups: [''], resources: ['pods/attach', 'pods/exec', 'pods/portforward', 'pods/proxy', 'secrets'], verbs: readVerbs },
      { apiGroups: [''], resources: ['serviceaccounts'], verbs: ['impersonate'] },
      { apiGroups: [''], resources: ['serviceaccounts/token'], verbs: ['create'] },
      {
        apiGroups: [''],
        resources: ['pods', 'pods/attach', 'pods/exec', 'pods/portforward', 'pods/proxy', 'configmaps', 'secrets', 'serviceaccounts', 'services'],
        verbs: writeVerbs,
      },
      { apiGroups: ['apps'], resources: ['daemonsets', 'deployments', 'replicasets', 'statefulsets'], verbs: writeVerbs },
      { apiGroups: ['batch'], resources: ['cronjobs', 'jobs'], verbs: writeVerbs },
    ],
  },
  view: {
    metadata: { name: 'view', labels: { 'rbac.authorization.k8s.io/aggregate-to-edit': 'true' } },
    aggregationRule: { clusterRoleSelectors: [{ matchLabels: { 'rbac.authorization.k8s.io/aggregate-to-view': 'true' } }] },
  },
  edit: {
    metadata: { name: 'edit' },
    aggregationRule: { clusterRoleSelectors: [{ matchLabels: { 'rbac.authorization.k8s.io/aggregate-to-edit': 'true' } }] },
  },
};

const ok = (status: number, body: unknown) => ({ status, body });
const exists = { kind: 'Status', reason: 'AlreadyExists', message: 'already exists' };
const missing = { kind: 'Status', reason: 'NotFound', message: 'not found' };

/** The access objects of one cluster. */
export class KubeAccessStore {
  readonly namespaces = new Map<string, Json>();
  /** `<namespace>/<name>`. */
  readonly serviceAccounts = new Set<string>();
  readonly bindings = new Map<string, Json>();
  readonly clusterRoles = new Map<string, Json>();
  readonly admissionPolicies = new Map<string, Json>();
  readonly admissionBindings = new Map<string, Json>();
  /** Each live minted token's service account (`<namespace>/<name>`). */
  readonly tokens = new Map<string, string>();

  /**
   * Answers an access request, or undefined when the path is none of the access objects'. `issue` names a new token;
   * `noAdmissionApi` answers 404 for the admission API (a cluster before 1.30).
   */
  handle(
    request: { method: string; path: string; body?: unknown },
    options: { issue: () => string; now: () => number; noAdmissionApi?: boolean },
  ): { status: number; body: unknown } | undefined {
    const { method, path } = request;
    const body = request.body as Json;
    let m: RegExpExecArray | null;
    if (path === '/api/v1/namespaces' && method === 'POST') {
      if (this.namespaces.has(body.metadata.name)) return ok(409, exists);
      this.namespaces.set(body.metadata.name, body);
      return ok(201, body);
    }
    if ((m = /^\/api\/v1\/namespaces\/([^/]+)$/.exec(path))) {
      const found = this.namespaces.get(m[1]!);
      if (!found) return ok(404, missing);
      if (method === 'GET') return ok(200, found);
      if (method === 'DELETE') {
        this.namespaces.delete(m[1]!);
        for (const key of [...this.serviceAccounts]) if (key.startsWith(`${m[1]}/`)) this.#dropServiceAccount(key);
        return ok(200, { kind: 'Status', status: 'Success' });
      }
    }
    if ((m = /^\/api\/v1\/namespaces\/([^/]+)\/serviceaccounts$/.exec(path))) {
      if (!this.namespaces.has(m[1]!)) return ok(404, missing);
      if (method === 'GET')
        return ok(200, {
          kind: 'ServiceAccountList',
          items: [...this.serviceAccounts]
            .filter((key) => key.startsWith(`${m![1]}/`))
            .map((key) => ({ metadata: { namespace: m![1], name: key.slice(m![1]!.length + 1) } })),
        });
      if (method === 'POST') {
        const key = `${m[1]}/${body.metadata.name}`;
        if (this.serviceAccounts.has(key)) return ok(409, exists);
        this.serviceAccounts.add(key);
        return ok(201, body);
      }
    }
    if ((m = /^\/api\/v1\/namespaces\/([^/]+)\/serviceaccounts\/([^/]+)$/.exec(path)) && method === 'DELETE') {
      const key = `${m[1]}/${m[2]}`;
      if (!this.serviceAccounts.has(key)) return ok(404, missing);
      this.#dropServiceAccount(key);
      return ok(200, { kind: 'Status', status: 'Success' });
    }
    if ((m = /^\/api\/v1\/namespaces\/([^/]+)\/serviceaccounts\/([^/]+)\/token$/.exec(path)) && method === 'POST') {
      const key = `${m[1]}/${m[2]}`;
      if (!this.serviceAccounts.has(key)) return ok(404, missing);
      const token = options.issue();
      this.tokens.set(token, key);
      const ttl = body.spec.expirationSeconds as number;
      return ok(201, {
        ...body,
        status: { token, expirationTimestamp: new Date(options.now() + ttl * 1000).toISOString() },
      });
    }
    for (const [collection, store] of [
      ['/apis/rbac.authorization.k8s.io/v1/clusterroles', this.clusterRoles],
      ['/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicies', this.admissionPolicies],
      ['/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicybindings', this.admissionBindings],
    ] as const) {
      if (!path.startsWith(collection)) continue;
      if (options.noAdmissionApi && collection.includes('admissionregistration'))
        return ok(404, { kind: 'Status', reason: 'NotFound', message: 'the server could not find the requested resource' });
      if (path === collection && method === 'POST') {
        if (store.has(body.metadata.name)) return ok(409, exists);
        store.set(body.metadata.name, body);
        return ok(201, body);
      }
      if (path.startsWith(`${collection}/`)) {
        const name = decodeURIComponent(path.slice(collection.length + 1));
        if (method === 'PUT') {
          if (!store.has(name) || body.metadata.name !== name) return ok(404, missing);
          store.set(name, body);
          return ok(200, body);
        }
        if (method === 'GET') return store.has(name) ? ok(200, store.get(name)) : ok(404, missing);
      }
    }
    const bindings = '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings';
    if (path === bindings && method === 'POST') {
      if (this.bindings.has(body.metadata.name)) return ok(409, exists);
      this.bindings.set(body.metadata.name, body);
      return ok(201, body);
    }
    if (path.startsWith(`${bindings}/`)) {
      const name = decodeURIComponent(path.slice(bindings.length + 1));
      const found = this.bindings.get(name);
      if (!found) return ok(404, missing);
      if (method === 'GET') return ok(200, found);
      if (method === 'DELETE') {
        this.bindings.delete(name);
        return ok(200, { kind: 'Status', status: 'Success' });
      }
    }
    return undefined;
  }

  #dropServiceAccount(key: string): void {
    this.serviceAccounts.delete(key);
    // A bound token stops working with its service account.
    for (const [token, owner] of [...this.tokens]) if (owner === key) this.tokens.delete(token);
  }

  /**
   * What a subject's credentials could still do in the cluster: its namespace, service accounts and the bindings that
   * name them (`Kind/name`). ClusterRoles and admission policies grant nothing on their own and are not listed.
   */
  subjectObjects(): string[] {
    return [
      ...[...this.namespaces.keys()].map((name) => `Namespace/${name}`),
      ...[...this.serviceAccounts].map((key) => `ServiceAccount/${key}`),
      ...[...this.bindings.keys()].map((name) => `ClusterRoleBinding/${name}`),
    ].sort();
  }

  /** The rules of a ClusterRole, its aggregation resolved (stored roles first, then the built-in ones). */
  rulesOf(name: string, seen = new Set<string>()): Rule[] {
    if (seen.has(name)) return [];
    seen.add(name);
    const role = this.clusterRoles.get(name) ?? builtinClusterRoles[name];
    if (!role) return [];
    if (!role.aggregationRule) return (role.rules ?? []) as Rule[];
    const roles = new Map<string, Json>([...Object.entries(builtinClusterRoles), ...this.clusterRoles]);
    const rules: Rule[] = [];
    for (const [other, candidate] of roles) {
      if (other === name) continue;
      const labels: Record<string, string> = candidate.metadata?.labels ?? {};
      const selected = (role.aggregationRule.clusterRoleSelectors ?? []).some((selector: Json) =>
        Object.entries(selector.matchLabels ?? {}).every(([key, value]) => labels[key] === value),
      );
      if (selected) rules.push(...this.rulesOf(other, seen));
    }
    return rules;
  }

  /** Whether RBAC lets the service account `<namespace>/<name>` do `request` (ClusterRoleBindings only). */
  rbacAllows(account: string, request: KubeAccessRequest): boolean {
    const [namespace, name] = account.split('/');
    const group = request.group ?? '';
    for (const binding of this.bindings.values()) {
      const named = (binding.subjects ?? []).some(
        (subject: Json) => subject.kind === 'ServiceAccount' && subject.name === name && subject.namespace === namespace,
      );
      if (!named || binding.roleRef?.kind !== 'ClusterRole') continue;
      const allowed = this.rulesOf(binding.roleRef.name).some(
        (rule) =>
          (rule.apiGroups ?? []).some((g) => g === '*' || g === group) &&
          (rule.resources ?? []).some((r) => r === '*' || r === request.resource) &&
          (rule.verbs ?? []).some((v) => v === '*' || v === request.verb),
      );
      if (allowed) return true;
    }
    return false;
  }

  /**
   * Whether the bound ValidatingAdmissionPolicies refuse a request, as the API server would decide for what the
   * drivers install: the namespace selector (In on kubernetes.io/metadata.name), the operations, a matchCondition on
   * the requester's groups, and a validation on whether the requester may escalate ClusterRoles (`canEscalate`).
   */
  admissionDenies(request: { namespace: string; operation: string; groups: string[]; canEscalate: boolean }): boolean {
    for (const binding of this.admissionBindings.values()) {
      if (!binding.spec?.validationActions?.includes('Deny')) continue;
      const policy = this.admissionPolicies.get(binding.spec.policyName);
      if (!policy?.spec?.matchConstraints) continue;
      const constraints = policy.spec.matchConstraints;
      const selected = (constraints.namespaceSelector?.matchExpressions ?? []).every(
        (expression: Json) =>
          expression.key === 'kubernetes.io/metadata.name' &&
          expression.operator === 'In' &&
          expression.values.includes(request.namespace),
      );
      const operation = (constraints.resourceRules ?? []).some((rule: Json) => rule.operations.includes(request.operation));
      const conditions = (policy.spec.matchConditions ?? []).every((condition: Json) => {
        const group = /g == '([^']+)'/.exec(condition.expression)?.[1];
        return group !== undefined && request.groups.includes(group);
      });
      if (!selected || !operation || !conditions) continue;
      for (const validation of policy.spec.validations ?? []) {
        const escalate = validation.expression.endsWith(".resource('clusterroles').check('escalate').allowed()");
        if (!escalate || !request.canEscalate) return true;
      }
    }
    return false;
  }

  /**
   * Whether a minted token may do `request`: it names a live service account, RBAC allows it, and no bound admission
   * policy refuses it (writes are CREATE/UPDATE/DELETE; create or get on pods/exec, attach, portforward and proxy is
   * CONNECT). Impersonation and TokenRequest are authorization only, as on a real API server.
   */
  can(token: string, request: KubeAccessRequest): boolean {
    const account = this.tokens.get(token);
    if (account === undefined || !this.rbacAllows(account, request)) return false;
    if (request.namespace === undefined) return true;
    const connect = /^pods\/(exec|attach|portforward|proxy)$/.test(request.resource) && ['create', 'get'].includes(request.verb);
    const operation = connect
      ? 'CONNECT'
      : ({ create: 'CREATE', update: 'UPDATE', patch: 'UPDATE', delete: 'DELETE', deletecollection: 'DELETE' } as Record<string, string>)[
          request.verb
        ];
    // TokenRequest is a create on a subresource: admission sees it as a CREATE too.
    if (operation === undefined) return true;
    const namespace = account.split('/')[0]!;
    return !this.admissionDenies({
      namespace: request.namespace,
      operation,
      groups: ['system:serviceaccounts', `system:serviceaccounts:${namespace}`, 'system:authenticated'],
      canEscalate: this.rbacAllows(account, { verb: 'escalate', resource: 'clusterroles', group: 'rbac.authorization.k8s.io' }),
    });
  }
}

/**
 * The access stores of every cluster an emulator serves, by the cluster's API host. Tests that look at "the" cluster
 * read the store of the host the last request went to (or one made before any request, which the first host takes).
 */
export class KubeAccessClusters {
  readonly #stores = new Map<string, KubeAccessStore>();
  #unclaimed: KubeAccessStore | undefined;
  #last: KubeAccessStore | undefined;

  /** The store of the cluster whose API is at `host`. */
  of(host: string): KubeAccessStore {
    let store = this.#stores.get(host);
    if (!store) {
      store = this.#unclaimed ?? new KubeAccessStore();
      this.#unclaimed = undefined;
      this.#stores.set(host, store);
    }
    this.#last = store;
    return store;
  }

  /** The store a single-cluster test means: the last one used. */
  get current(): KubeAccessStore {
    if (this.#last) return this.#last;
    this.#unclaimed ??= new KubeAccessStore();
    return this.#unclaimed;
  }

  /** The store of the cluster at this origin or host, if any request reached it. */
  find(server: string): KubeAccessStore | undefined {
    const host = server.includes('://') ? new URL(server).host : server;
    return this.#stores.get(host);
  }

  /** Whether a minted token may do `request` on the cluster at `server` (`https://host`). */
  can(server: string, token: string, request: KubeAccessRequest): boolean {
    return this.find(server)?.can(token, request) ?? false;
  }
}
