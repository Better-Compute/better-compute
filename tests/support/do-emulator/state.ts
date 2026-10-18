import { readFileSync } from 'node:fs';

// The state of the DigitalOcean emulator: an id counter and the maps the service modules fill in.
// Fixture-backed seeds (regions, sizes) come from tests/fixtures/digitalocean, so every body the
// emulator returns has the shape of a recorded one.

export type Json = Record<string, any>;

const fixtureDir = new URL('../../fixtures/digitalocean/', import.meta.url);

/** A fixture file's content without its `_provenance` note. */
export function fixture(name: string): Json {
  const { _provenance, ...rest } = JSON.parse(
    readFileSync(new URL(`${name}.json`, fixtureDir), 'utf8'),
  ) as Json;
  return rest;
}

/** The error fixtures, by their `name` (`unauthorized`, `422-name-in-use`, …). */
export function errorFixtures(): Map<string, { status: number; code: string; body: Json }> {
  const entries = (fixture('errors').errors ?? []) as {
    name: string;
    status: number;
    code: string;
    body: Json;
  }[];
  return new Map(entries.map((entry) => [entry.name, entry]));
}

export class DoState {
  #id = 100_000;

  /** Keyed by id. DO Droplet resources. */
  droplets = new Map<number, Json>();
  /** Keyed by uuid. DO VPC resources. */
  vpcs = new Map<string, Json>();
  /** Keyed by uuid. DO Cloud Firewall resources. */
  firewalls = new Map<string, Json>();
  /** Keyed by fingerprint. DO SSH key resources. */
  sshKeys = new Map<string, Json>();
  /** Keyed by id. DO action resources. */
  actions = new Map<number, Json>();
  /** Keyed by name. DO tag resources. */
  tags = new Map<string, Json>();
  regions: Json[] = structuredClone(fixture('regions').regions as Json[]);
  sizes: Json[] = structuredClone(fixture('sizes').sizes as Json[]);

  /** The next numeric id (Droplets, actions, keys all draw from one counter). */
  nextId(): number {
    return ++this.#id;
  }
}
