// Fakes for the AWS live-suite guards and sweeper (STS identity, Cost Explorer month-to-date), on
// the platform emulator. The live suite itself never uses them: they pin the guards' behavior in
// the default suite so the guards are known to fail closed before anyone points them at AWS.
import { AwsEmulator, EmuError, escapeXml, jsonResponse, xmlResponse, type EmuRequest } from './aws-platform-emulator/index.js';

const form = (request: EmuRequest) => new URLSearchParams(Buffer.from(request.body).toString('utf8'));
const json = (request: EmuRequest) => JSON.parse(Buffer.from(request.body).toString('utf8') || '{}') as Record<string, unknown>;

/** STS GetCallerIdentity answering as `state.account`. */
export function stsFake(emu: AwsEmulator, state: { account: string; arn?: string }) {
  emu.register('sts', {
    protocol: 'query',
    handle(request) {
      const action = form(request).get('Action');
      if (action !== 'GetCallerIdentity') throw new EmuError('InvalidAction', `no ${action}`);
      const arn = state.arn ?? `arn:aws:iam::${state.account}:user/live`;
      return xmlResponse(
        `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>${escapeXml(arn)}</Arn><UserId>AIDATEST</UserId><Account>${state.account}</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>req</RequestId></ResponseMetadata></GetCallerIdentityResponse>`,
      );
    },
  });
}

/** Cost Explorer GetCostAndUsage: one result per entry of `state.results`, one per page. */
export function costExplorerFake(emu: AwsEmulator, state: { results: { amount: string; unit?: string }[] }) {
  const requests: Record<string, unknown>[] = [];
  emu.register('ce', {
    protocol: 'json',
    handle(request) {
      if (request.operation !== 'GetCostAndUsage') throw new EmuError('UnknownOperationException', request.operation);
      const body = json(request);
      requests.push(body);
      const page = typeof body.NextPageToken === 'string' ? Number(body.NextPageToken) : 0;
      const result = state.results[page];
      const period = body.TimePeriod as { Start: string; End: string };
      return jsonResponse({
        ResultsByTime: result
          ? [{ TimePeriod: period, Total: { UnblendedCost: { Amount: result.amount, Unit: result.unit ?? 'USD' } }, Groups: [], Estimated: true }]
          : [],
        ...(page + 1 < state.results.length ? { NextPageToken: String(page + 1) } : {}),
      });
    },
  });
  return { requests };
}
