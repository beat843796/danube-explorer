"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { selectLockEtaCandidates } = require(
  path.join(__dirname, "..", "static", "lockEta.js")
);

// Simulated rkm anchors loosely modelled on the Vienna lock chain:
//   Greifenstein (rkm 1949.2) → Nußdorf (rkm 1929) → Freudenau (rkm 1921.05)
// "selected lock" is Nußdorf in this fixture.
const lockRkm = 1929;
const upMax = 1949.2;    // next upstream neighbor
const downMin = 1921.05; // next downstream neighbor

const rkmOf = (v) => v.rkm;
const dirOf = (v) => v.dir;

function vessel(overrides) {
  return {
    trackId: overrides.trackId ?? "t",
    isMoving: true,
    speedGround: 12,
    ...overrides,
  };
}

function select(vessels, overrides = {}) {
  return selectLockEtaCandidates({
    vessels,
    lockRkm,
    upMax,
    downMin,
    vesselRkm: rkmOf,
    vesselDirection: dirOf,
    ...overrides,
  });
}

test("no vessels → both candidates null", () => {
  const r = select([]);
  assert.equal(r.upLockCandidate, null);
  assert.equal(r.downLockCandidate, null);
});

test("downstream-of-lock vessel heading up → upstream-locking candidate", () => {
  const v = vessel({ rkm: 1925, dir: "upstream" });
  const r = select([v]);
  assert.equal(r.upLockCandidate.vessel, v);
  assert.equal(r.upLockCandidate.rkm, 1925);
  assert.equal(r.upLockCandidate.distKm, 4);
  assert.equal(r.downLockCandidate, null);
});

test("upstream-of-lock vessel heading down → downstream-locking candidate", () => {
  const v = vessel({ rkm: 1935, dir: "downstream" });
  const r = select([v]);
  assert.equal(r.downLockCandidate.vessel, v);
  assert.equal(r.downLockCandidate.rkm, 1935);
  assert.equal(r.downLockCandidate.distKm, 6);
  assert.equal(r.upLockCandidate, null);
});

test("vessel moving in the wrong direction is rejected", () => {
  const wrongUp = vessel({ rkm: 1925, dir: "downstream" }); // below lock, but going down
  const wrongDown = vessel({ rkm: 1935, dir: "upstream" }); // above lock, but going up
  const r = select([wrongUp, wrongDown]);
  assert.equal(r.upLockCandidate, null);
  assert.equal(r.downLockCandidate, null);
});

test("vessel past the next-upstream lock bound is excluded", () => {
  const beyond = vessel({ rkm: 1960, dir: "downstream" }); // > upMax (1949.2)
  const r = select([beyond]);
  assert.equal(r.downLockCandidate, null);
});

test("vessel past the next-downstream lock bound is excluded", () => {
  const beyond = vessel({ rkm: 1900, dir: "upstream" }); // < downMin (1921.05)
  const r = select([beyond]);
  assert.equal(r.upLockCandidate, null);
});

test("vessel exactly at lock rkm is excluded", () => {
  const atLock = vessel({ rkm: lockRkm, dir: "upstream" });
  const r = select([atLock]);
  assert.equal(r.upLockCandidate, null);
  assert.equal(r.downLockCandidate, null);
});

test("vessel exactly at the neighbor lock rkm is excluded", () => {
  const atUp = vessel({ rkm: upMax, dir: "downstream" });
  const atDown = vessel({ rkm: downMin, dir: "upstream" });
  const r = select([atUp, atDown]);
  assert.equal(r.upLockCandidate, null);
  assert.equal(r.downLockCandidate, null);
});

test("closest of multiple valid candidates wins on each side", () => {
  const farDown = vessel({ trackId: "far", rkm: 1945, dir: "downstream" });   // d=16
  const nearDown = vessel({ trackId: "near", rkm: 1932, dir: "downstream" }); // d=3
  const farUp = vessel({ trackId: "far2", rkm: 1922, dir: "upstream" });      // d=7
  const nearUp = vessel({ trackId: "near2", rkm: 1927, dir: "upstream" });    // d=2
  const r = select([farDown, nearDown, farUp, nearUp]);
  assert.equal(r.downLockCandidate.vessel.trackId, "near");
  assert.equal(r.downLockCandidate.distKm, 3);
  assert.equal(r.upLockCandidate.vessel.trackId, "near2");
  assert.equal(r.upLockCandidate.distKm, 2);
});

test("stopped vessel is excluded", () => {
  const stopped = vessel({ rkm: 1925, dir: "upstream", isMoving: false });
  const r = select([stopped]);
  assert.equal(r.upLockCandidate, null);
});

test("zero-speed vessel is excluded", () => {
  const zero = vessel({ rkm: 1925, dir: "upstream", speedGround: 0 });
  const r = select([zero]);
  assert.equal(r.upLockCandidate, null);
});

test("negative-speed vessel is excluded", () => {
  const neg = vessel({ rkm: 1925, dir: "upstream", speedGround: -5 });
  const r = select([neg]);
  assert.equal(r.upLockCandidate, null);
});

test("missing speedGround is excluded", () => {
  const noSpeed = vessel({ rkm: 1925, dir: "upstream", speedGround: undefined });
  const r = select([noSpeed]);
  assert.equal(r.upLockCandidate, null);
});

test("vesselRkm null → vessel excluded", () => {
  const v = vessel({ rkm: null, dir: "upstream" });
  const r = select([v]);
  assert.equal(r.upLockCandidate, null);
});

test("missing vesselDirection → vessel excluded", () => {
  const v = vessel({ rkm: 1925, dir: null });
  const r = select([v]);
  assert.equal(r.upLockCandidate, null);
});

test("no next-upstream neighbor (Infinity) → vessel arbitrarily far above still counts", () => {
  const v = vessel({ rkm: 2500, dir: "downstream" });
  const r = select([v], { upMax: Infinity });
  assert.equal(r.downLockCandidate.rkm, 2500);
  assert.equal(r.downLockCandidate.distKm, 571);
});

test("no next-downstream neighbor (-Infinity) → vessel arbitrarily far below still counts", () => {
  const v = vessel({ rkm: 500, dir: "upstream" });
  const r = select([v], { downMin: -Infinity });
  assert.equal(r.upLockCandidate.rkm, 500);
  assert.equal(r.upLockCandidate.distKm, lockRkm - 500);
});

test("3-rect simulation: dedup'd vessel stream picks correct candidates", () => {
  // Simulates the dedup'd union of vessels returned from rect-1, rect, rect+1.
  // Each vessel labelled with the rect it came from (informational only).
  const vessels = [
    vessel({ trackId: "rect-1-A", rkm: 1924, dir: "upstream", speedGround: 10 }),
    vessel({ trackId: "rect-1-B", rkm: 1900, dir: "upstream", speedGround: 11 }), // below downMin → excluded
    vessel({ trackId: "rect-A",   rkm: 1932, dir: "downstream", speedGround: 14 }),
    vessel({ trackId: "rect-B",   rkm: 1928, dir: "downstream", speedGround: 9 }),  // wrong dir for upstream side
    vessel({ trackId: "rect-C",   rkm: 1927, dir: "upstream", speedGround: 8 }),    // valid up; not closest
    vessel({ trackId: "rect-D",   rkm: 1940, dir: "downstream", speedGround: 12 }), // valid down; not closest
    vessel({ trackId: "rect+1-A", rkm: 1955, dir: "downstream", speedGround: 13 }), // > upMax → excluded
    vessel({ trackId: "rect+1-B", rkm: 1948, dir: "upstream", speedGround: 9 }),    // wrong side for upstream cand
  ];

  const r = select(vessels);
  assert.equal(r.upLockCandidate.vessel.trackId, "rect-C");
  assert.equal(r.upLockCandidate.distKm, 2); // 1929 - 1927
  assert.equal(r.downLockCandidate.vessel.trackId, "rect-A");
  assert.equal(r.downLockCandidate.distKm, 3); // 1932 - 1929
});

test("dedup at the call site is assumed: function does not dedup by trackId", () => {
  // The production code dedups via a Map keyed by trackId before calling us.
  // If the caller passes duplicates with the same rkm, the closest-wins logic
  // still picks one of them; this test pins that behaviour.
  const a = vessel({ trackId: "dup", rkm: 1932, dir: "downstream" });
  const b = vessel({ trackId: "dup", rkm: 1932, dir: "downstream" });
  const r = select([a, b]);
  assert.equal(r.downLockCandidate.distKm, 3);
});

test("vessels iterator (not just array) is supported", () => {
  // updateLockEta passes `seen.values()` — confirm an iterator works.
  const m = new Map();
  m.set("a", vessel({ trackId: "a", rkm: 1925, dir: "upstream" }));
  m.set("b", vessel({ trackId: "b", rkm: 1935, dir: "downstream" }));
  const r = select(m.values());
  assert.equal(r.upLockCandidate.vessel.trackId, "a");
  assert.equal(r.downLockCandidate.vessel.trackId, "b");
});
