// Package roote2e is the end-to-end test of bcd helper running as root (build tag helpere2e, run by
// scripts/helper-e2e.mjs): the install script's --unprivileged mode on a scratch overlay of the host,
// signed host units applied through the helper, and libvirt definitions checked by it, each asked
// for by the installed bcd binary as the bcd user. It has no code of its own.
package roote2e
