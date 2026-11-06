import { describe, expect, it } from 'vitest';
import {
  awsIamPolicyCommand,
  iamPolicy,
  type AwsCommandContext,
  type IamStatement,
} from '@better-compute/provider-aws';

const actionsOf = (statement: IamStatement) =>
  typeof statement.Action === 'string' ? [statement.Action] : [...statement.Action];

function harness(flags: AwsCommandContext['flags']) {
  const out: string[] = [];
  const notes: string[] = [];
  const context: AwsCommandContext = {
    flags,
    io: { out: (message) => out.push(message) },
    note: (message) => notes.push(message),
    path: (value) => value,
  };
  return { out, notes, context };
}

describe('provider-aws FinOps CLI', () => {
  it('iam policy adds Cost Explorer and Price List reads only when asked', async () => {
    const plain = iamPolicy();
    const all = plain.Statement.flatMap(actionsOf);
    expect(all).not.toContain('ce:GetCostAndUsage');
    expect(all).not.toContain('pricing:GetProducts');
    const finops = iamPolicy({ costs: true, prices: true });
    const costs = finops.Statement.find((statement) => statement.Sid === 'CostExplorer')!;
    expect(actionsOf(costs)).toEqual(['ce:GetCostAndUsage']);
    expect(costs.Resource).toBe('*');
    const prices = finops.Statement.find((statement) => statement.Sid === 'PriceList')!;
    expect(actionsOf(prices)).toEqual(['pricing:GetProducts']);
    // nothing else gains a wildcard resource
    expect(finops.Statement.length).toBe(plain.Statement.length + 2);
    // the Price List serves the commercial partition only
    expect(() => iamPolicy({ partition: 'aws-us-gov', prices: true })).toThrow(/--prices/);
    const { out, context } = harness({ costs: true });
    await awsIamPolicyCommand().run(context);
    expect(JSON.parse(out[0]!).Statement.map((s: IamStatement) => s.Sid)).toContain('CostExplorer');
    expect(awsIamPolicyCommand().flags.costs.type).toBe('boolean');
  });
});
