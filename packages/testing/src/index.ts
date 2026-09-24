/**
 * Testing kit for better-compute (PLAN.md §15). P0 ships `computeFixture()` (PGlite, migrated; the
 * sim clock bound to `compute_now()`; a scripted IAM; an HTTP `request()` helper), `closeFixtures()`
 * and `fakeIam()`. The fleet simulator, `FakeDaemon`, the invariant checker and the conformance
 * runners arrive in v0.1.
 */
export { closeFixtures, computeFixture } from './fixture.js';
export type {
  ComputeFixture,
  ComputeFixtureOptions,
  FixtureClock,
  FixtureRequestOptions,
  FixtureResponse,
  FixtureTenant,
} from './fixture.js';
export { fakeIam, tokenOf } from './fake-iam.js';
export type {
  FakeIam,
  FakeIamCall,
  FakeIamMethod,
  FakeIamOptions,
  FakeIamRule,
} from './fake-iam.js';
