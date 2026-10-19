# @better-compute/aws-core

Shared AWS plumbing for better-compute providers, with no AWS SDK dependency. Today it holds the request serializers for the EC2 and awsQuery protocols and a hardened XML reader for their responses. SigV4 signing, endpoints, the JSON protocol clients and credential sources follow in the AWS program's later phases (`docs/superpowers/plans/2026-10-18-aws-integration-program.md`).

It depends only on `@better-compute/core`. It is not in the `better-compute` umbrella: install it where you use it.

```sh
pnpm add @better-compute/aws-core
```

## Query serializers

| Function                                     | Protocol                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| `serializeEc2Query(action, version, params)` | EC2: lists flatten to `Name.1`, `Name.1.Sub`; booleans are `true`/`false`.        |
| `serializeAwsQuery(action, version, params)` | awsQuery (IAM, STS, …): lists flatten to `Name.member.1`, maps to `Name.entry.1`. |

Both return a form-encoded body with `Action` and `Version` and the keys sorted. `undefined` members are left out. A `Map` is an awsQuery map and has no EC2 form.

## XML reader

`parseXml(text, limits?)` parses an AWS XML response into an `XmlElement` tree. Namespaces are ignored (names are local names), entities are decoded, and `items(name)` reads both the EC2 `<item>` and the query `<member>` list forms. The reader refuses DTDs and entity declarations, and enforces `maxBytes` (default 16 MiB) and `maxDepth` (default 64). A refused or malformed document is a `ComputeError`.

## License

Apache-2.0.
