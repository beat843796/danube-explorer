// UMD shim: usable as a browser global (`window.LockEta`) and via `require` in Node tests.
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.LockEta = factory();
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // Pick the closest vessel on each side of `lockRkm` that is moving in the
  // direction that would lock it through, constrained to the open interval
  // between the selected lock and its neighbor on that side (or unbounded if
  // there is no neighbor).
  //
  // `vesselRkm` and `vesselDirection` are injected so the function stays pure
  // and trivially testable. Returns `{ upLockCandidate, downLockCandidate }`,
  // each either `null` or `{ vessel, rkm, distKm }`.
  function selectLockEtaCandidates({
    vessels,
    lockRkm,
    upMax,
    downMin,
    vesselRkm,
    vesselDirection,
  }) {
    let downLockCandidate = null;
    let upLockCandidate = null;
    let downDist = Infinity;
    let upDist = Infinity;
    for (const v of vessels) {
      if (!v.isMoving) continue;
      if (typeof v.speedGround !== "number" || v.speedGround <= 0) continue;
      const vRkm = vesselRkm(v);
      if (vRkm == null) continue;
      const dir = vesselDirection(v);
      if (vRkm > lockRkm && vRkm < upMax && dir === "downstream") {
        const d = vRkm - lockRkm;
        if (d < downDist) {
          downDist = d;
          downLockCandidate = { vessel: v, rkm: vRkm, distKm: d };
        }
      } else if (vRkm < lockRkm && vRkm > downMin && dir === "upstream") {
        const d = lockRkm - vRkm;
        if (d < upDist) {
          upDist = d;
          upLockCandidate = { vessel: v, rkm: vRkm, distKm: d };
        }
      }
    }
    return { upLockCandidate, downLockCandidate };
  }

  return { selectLockEtaCandidates };
});
