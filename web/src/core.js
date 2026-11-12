/* Noyau de calcul : fuzzy c-means, n-SD, FWHM, masses, segments AHA.
   Traduction fidèle du script Python (lge/methodes.py, lge/analyse.py, lge/aha.py). */
const LGE = (() => {
  "use strict";

  const NOMS_SEGMENTS = {
    1: "basal antérieur", 2: "basal antéro-septal", 3: "basal inféro-septal", 4: "basal inférieur",
    5: "basal inféro-latéral", 6: "basal antéro-latéral",
    7: "médian antérieur", 8: "médian antéro-septal", 9: "médian inféro-septal", 10: "médian inférieur",
    11: "médian inféro-latéral", 12: "médian antéro-latéral",
    13: "apical antérieur", 14: "apical septal", 15: "apical inférieur", 16: "apical latéral",
  };

  const mod = (a, n) => ((a % n) + n) % n;

  /* Pixels dont le centre est dans le polygone (x = colonne, y = ligne).
     Même règle que matplotlib (Path.contains_points), pour des résultats identiques au script Python. */
  function polygonMask(poly, rows, cols) {
    const m = new Uint8Array(rows * cols);
    if (!poly || poly.length < 3) return m;
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const [x, y] of poly) { xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
    const r0 = Math.max(0, Math.floor(ymin)), r1 = Math.min(rows - 1, Math.ceil(ymax));
    const c0 = Math.max(0, Math.floor(xmin)), c1 = Math.min(cols - 1, Math.ceil(xmax));
    const n = poly.length;
    for (let ty = r0; ty <= r1; ty++) {
      for (let tx = c0; tx <= c1; tx++) {
        let inside = false;
        let [vx0, vy0] = poly[n - 1];
        let y0 = vy0 >= ty;
        for (let i = 0; i < n; i++) {
          const [vx1, vy1] = poly[i];
          const y1 = vy1 >= ty;
          if (y0 !== y1 && (((vy1 - ty) * (vx0 - vx1) >= (vx1 - tx) * (vy0 - vy1)) === y1)) inside = !inside;
          vx0 = vx1; vy0 = vy1; y0 = y1;
        }
        if (inside) m[ty * cols + tx] = 1;
      }
    }
    return m;
  }

  function percentile(values, q) {
    const s = Float64Array.from(values).sort();
    if (!s.length) return NaN;
    const pos = (q / 100) * (s.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }
  const mean = (a) => { let s = 0; for (const v of a) s += v; return s / a.length; };
  const std1 = (a) => { if (a.length < 2) return 0; const m = mean(a); let s = 0; for (const v of a) s += (v - m) ** 2; return Math.sqrt(s / (a.length - 1)); };

  /* Fuzzy c-means 1D, initialisation déterministe aux percentiles. */
  function fcm(x, c = 2, m = 2, maxIter = 500, tol = 1e-6) {
    if (c < 2) throw new Error("Il faut au moins 2 classes.");
    if (m <= 1) throw new Error("Le coefficient de flou doit être > 1.");
    const n = x.length;
    let xmin = Infinity, xmax = -Infinity;
    for (const v of x) { if (v < xmin) xmin = v; if (v > xmax) xmax = v; }
    const etendue = (xmax - xmin) || 1;
    let centres = [];
    for (let k = 0; k < c; k++) {
      const q = 100 / (2 * c) + k * ((100 - 100 / c) / (c - 1));
      centres.push(percentile(x, q) + k * 1e-6 * etendue);
    }
    const exp = 2 / (m - 1);
    const u = new Float64Array(n * c);
    const majU = () => {
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let k = 0; k < c; k++) { const v = Math.pow(Math.abs(x[i] - centres[k]) + 1e-12, -exp); u[i * c + k] = v; s += v; }
        for (let k = 0; k < c; k++) u[i * c + k] /= s;
      }
    };
    let iter = 0, converge = false;
    for (iter = 1; iter <= maxIter; iter++) {
      majU();
      const num = new Float64Array(c), den = new Float64Array(c);
      for (let i = 0; i < n; i++) for (let k = 0; k < c; k++) { const w = Math.pow(u[i * c + k], m); num[k] += w * x[i]; den[k] += w; }
      let variation = 0;
      const nouveaux = centres.map((_, k) => num[k] / den[k]);
      for (let k = 0; k < c; k++) variation = Math.max(variation, Math.abs(nouveaux[k] - centres[k]));
      centres = nouveaux;
      if (variation < tol * etendue) { converge = true; break; }
    }
    if (iter > maxIter) iter = maxIter;
    const ordre = centres.map((v, k) => [v, k]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
    majU();
    const uo = new Float64Array(n * c);
    for (let i = 0; i < n; i++) for (let k = 0; k < c; k++) uo[i * c + k] = u[i * c + ordre[k]];
    return { centres: ordre.map((k) => centres[k]), appartenance: uo, c, iterations: iter, converge };
  }

  function lgeFcm(x, c, m, classesRehaussees = 1) {
    if (!(classesRehaussees >= 1 && classesRehaussees < c)) throw new Error("classes rehaussées doit être entre 1 et c-1.");
    const r = fcm(x, c, m);
    const n = x.length, ponderation = new Float64Array(n), defuzzifie = new Float64Array(n);
    const premier = c - classesRehaussees;
    for (let i = 0; i < n; i++) {
      let s = 0, best = 0, bestV = -1;
      for (let k = 0; k < c; k++) { const v = r.appartenance[i * c + k]; if (k >= premier) s += v; if (v > bestV) { bestV = v; best = k; } }
      ponderation[i] = s; defuzzifie[i] = best >= premier ? 1 : 0;
    }
    return { ...r, ponderation, defuzzifie };
  }

  /* --- géométrie d'une coupe --------------------------------------------------- */
  function centreVG(s) {
    if (s.endo && s.endo.length >= 3) return [mean(s.endo.map((p) => p[0])), mean(s.endo.map((p) => p[1]))];
    let sx = 0, sy = 0, n = 0;
    for (let i = 0; i < s.myo.length; i++) if (s.myo[i]) { sx += i % s.cols; sy += Math.floor(i / s.cols); n++; }
    return [sx / n, sy / n];
  }
  const angleDe = (centre, x, y) => mod(Math.atan2(-(y - centre[1]), x - centre[0]) * 180 / Math.PI, 360);

  /* Construit les masques myocarde / remote d'une coupe à partir des polygones. */
  function preparerCoupe(s) {
    if (!s.myo) {
      if (!(s.endo && s.epi && s.endo.length >= 3 && s.epi.length >= 3)) return false;
      const epi = polygonMask(s.epi, s.rows, s.cols), endo = polygonMask(s.endo, s.rows, s.cols);
      s.myo = new Uint8Array(s.rows * s.cols);
      for (let i = 0; i < s.myo.length; i++) s.myo[i] = epi[i] && !endo[i] ? 1 : 0;
    }
    s.idx = [];
    for (let i = 0; i < s.myo.length; i++) if (s.myo[i]) s.idx.push(i);
    if (!s.idx.length) return false;
    s.remoteMask = null;
    if (s.remote && s.remote.length >= 3) {
      const r = polygonMask(s.remote, s.rows, s.cols);
      for (let i = 0; i < r.length; i++) r[i] = r[i] && s.myo[i] ? 1 : 0;
      if (r.some((v) => v)) s.remoteMask = r;
    }
    return true;
  }

  function remoteAutomatique(s) {
    const c = centreVG(s), sect = [], sommes = new Float64Array(6), nb = new Float64Array(6);
    for (const i of s.idx) {
      const k = Math.floor(angleDe(c, i % s.cols, Math.floor(i / s.cols)) / 60) % 6;
      sect.push(k); sommes[k] += s.image[i]; nb[k]++;
    }
    let choisi = 0, best = Infinity;
    for (let k = 0; k < 6; k++) { const mo = nb[k] ? sommes[k] / nb[k] : Infinity; if (mo < best) { best = mo; choisi = k; } }
    const m = new Uint8Array(s.rows * s.cols);
    s.idx.forEach((i, j) => { if (sect[j] === choisi) m[i] = 1; });
    return m;
  }

  /* --- AHA --------------------------------------------------------------------- */
  function attribuerNiveaux(coupes) {
    const ord = [...coupes].sort((a, b) => a.indice - b.indice);
    const surf = (s) => s.idx.length * s.spacing[0] * s.spacing[1];
    if (surf(ord[0]) < surf(ord[ord.length - 1])) ord.reverse();
    const n = ord.length, tailles = [0, 1, 2].map((k) => Math.floor(n / 3) + (k < n % 3 ? 1 : 0));
    let i = 0;
    ["basal", "median", "apical"].forEach((nom, g) => {
      for (let k = 0; k < tailles[g]; k++, i++) { if (!["basal", "median", "apical"].includes(ord[i].niveauImpose)) ord[i].niveau = nom; else ord[i].niveau = ord[i].niveauImpose; }
    });
  }

  function anglesReference(coupes) {
    const connus = {};
    for (const s of coupes) if (s.rv) connus[s.indice] = angleDe(centreVG(s), s.rv[0], s.rv[1]);
    const cles = Object.keys(connus).map(Number);
    if (!cles.length) return null;
    const res = {};
    for (const s of coupes) {
      let best = cles[0];
      for (const k of cles) if (Math.abs(k - s.indice) < Math.abs(best - s.indice)) best = k;
      res[s.indice] = connus[best];
    }
    return res;
  }

  function carteSegments(s, angleVD, sensInverse) {
    const c = centreVG(s), carte = new Int16Array(s.rows * s.cols);
    for (const i of s.idx) {
      let rel = mod(angleDe(c, i % s.cols, Math.floor(i / s.cols)) - angleVD, 360);
      if (sensInverse) rel = mod(360 - rel, 360);
      let num;
      if (s.niveau === "apical") num = [14, 15, 16, 13][mod(Math.floor(mod(rel - 15, 360) / 90), 4)];
      else num = [2, 3, 4, 5, 6, 1][mod(Math.floor(rel / 60), 6)] + (s.niveau === "basal" ? 0 : 6);
      carte[i] = num;
    }
    return carte;
  }

  /* --- analyse d'un patient ------------------------------------------------------ */
  const fmtN = (n) => (Number.isInteger(n) ? String(n) : String(n));
  const r2 = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

  function epaisseurTranche(toutes, mode) {
    const pos = toutes.map((s) => s.position).sort((a, b) => a - b);
    const ep = percentile(toutes.map((s) => s.thickness), 50);
    const diffs = []; for (let i = 1; i < pos.length; i++) diffs.push(pos[i] - pos[i - 1]);
    const inter = diffs.length ? percentile(diffs, 50) : 0;
    if (mode === "coupe") return ep;
    if (mode === "intervalle") return inter || ep;
    return inter > 0 ? inter : ep;
  }

  function analyser(toutes, p, identifiant = "patient") {
    const avert = [];
    const coupes = toutes.filter((s) => preparerCoupe(s));
    if (!coupes.length) throw new Error("Aucune coupe n'a de contours épicarde et endocarde.");
    const tranche = epaisseurTranche(toutes, p.epaisseur);
    const vals = {}, poids = {};
    for (const s of coupes) { vals[s.indice] = Float64Array.from(s.idx, (i) => s.image[i]); poids[s.indice] = {}; }

    // myocarde sain de référence
    const avecRemote = coupes.filter((s) => s.remoteMask);
    let groupe = null;
    if (avecRemote.length) { groupe = []; for (const s of avecRemote) for (let i = 0; i < s.remoteMask.length; i++) if (s.remoteMask[i]) groupe.push(s.image[i]); }
    const stats = {};
    for (const s of coupes) {
      let ref, source;
      s.remoteAuto = null;
      if (s.remoteMask && p.nsdRemote !== "auto") { ref = []; for (let i = 0; i < s.remoteMask.length; i++) if (s.remoteMask[i]) ref.push(s.image[i]); source = "contour de la coupe"; }
      else if (groupe && p.nsdRemote !== "auto") { ref = groupe; source = "contours des autres coupes"; }
      else { s.remoteAuto = remoteAutomatique(s); ref = []; for (let i = 0; i < s.remoteAuto.length; i++) if (s.remoteAuto[i]) ref.push(s.image[i]); source = "automatique (secteur le plus sombre)"; }
      stats[s.indice] = { moy: mean(ref), et: std1(ref), source };
    }

    // fuzzy c-means
    let infos;
    const garde = p.fcmGardeFou > 0;
    if (p.fcmEchelle === "patient") {
      const tout = new Float64Array(coupes.reduce((a, s) => a + vals[s.indice].length, 0));
      let o = 0; for (const s of coupes) { tout.set(vals[s.indice], o); o += vals[s.indice].length; }
      const r = lgeFcm(tout, p.fcmC, p.fcmM, p.fcmClassesRehaussees);
      const moyR = mean(coupes.map((s) => stats[s.indice].moy)), etR = mean(coupes.map((s) => stats[s.indice].et));
      const contraste = etR ? (r.centres[r.centres.length - 1] - moyR) / etR : Infinity;
      const rejete = garde && contraste < p.fcmGardeFou;
      if (rejete) { r.ponderation.fill(0); r.defuzzifie.fill(0); avert.push(`garde-fou FCM : classe brillante à ${contraste.toFixed(1)} SD du myocarde sain, LGE FCM mis à 0`); }
      o = 0;
      for (const s of coupes) {
        const n = vals[s.indice].length;
        poids[s.indice].FCM_pondere = r.ponderation.slice(o, o + n);
        poids[s.indice].FCM_defuzzifie = r.defuzzifie.slice(o, o + n);
        o += n;
      }
      infos = { centres: r.centres.map((v) => r2(v)), iterations: r.iterations, converge: r.converge, contraste: r2(contraste), rejete };
    } else {
      for (const s of coupes) {
        const r = lgeFcm(vals[s.indice], p.fcmC, p.fcmM, p.fcmClassesRehaussees);
        const st = stats[s.indice], contraste = st.et ? (r.centres[r.centres.length - 1] - st.moy) / st.et : Infinity;
        s.fcmContraste = r2(contraste);
        if (garde && contraste < p.fcmGardeFou) { r.ponderation.fill(0); r.defuzzifie.fill(0); }
        poids[s.indice].FCM_pondere = r.ponderation; poids[s.indice].FCM_defuzzifie = r.defuzzifie;
      }
      infos = { centres: "par coupe", iterations: "", converge: "", contraste: "par coupe", rejete: "" };
    }

    // n-SD
    for (const s of coupes) {
      const { moy, et } = stats[s.indice];
      for (const n of p.nsdN) poids[s.indice][`${fmtN(n)}SD`] = vals[s.indice].map((v) => (v > moy + n * et ? 1 : 0));
    }
    // FWHM
    let maxi = null;
    if (p.fwhmEchelle === "patient") { const tout = []; for (const s of coupes) for (const v of vals[s.indice]) tout.push(v); maxi = percentile(tout, p.fwhmPercentile); }
    for (const s of coupes) {
      const mx = p.fwhmEchelle === "patient" ? maxi : percentile(vals[s.indice], p.fwhmPercentile);
      s.fwhmMax = mx;
      poids[s.indice].FWHM = vals[s.indice].map((v) => (v >= p.fwhmFraction * mx ? 1 : 0));
    }
    const methodes = Object.keys(poids[coupes[0].indice]);

    // AHA
    let cartes = {};
    for (const s of coupes) { s.niveau = s.niveauImpose || null; s.carte = null; }
    if (p.ahaActif) {
      attribuerNiveaux(coupes);
      const angles = anglesReference(coupes);
      if (angles) for (const s of coupes) { s.carte = carteSegments(s, angles[s.indice], p.ahaSensInverse); cartes[s.indice] = s.carte; }
      else avert.push("pas de point d'insertion du VD : segments AHA non calculés");
    }

    // masses
    const lignesCoupes = [], cumul = {};
    let totMyo = 0; const totLge = Object.fromEntries(methodes.map((m) => [m, 0]));
    for (const s of coupes) {
      const volPx = s.spacing[0] * s.spacing[1] * tranche / 1000;
      const mMyo = s.idx.length * volPx * p.densite;
      totMyo += mMyo;
      const l = { patient: identifiant, coupe: s.indice, niveau: s.niveau || "", position_mm: r2(s.position), masse_myocarde_g: r2(mMyo, 3) };
      for (const m of methodes) {
        let sw = 0; for (const w of poids[s.indice][m]) sw += w;
        const g = sw * volPx * p.densite; totLge[m] += g;
        l[`LGE_g_${m}`] = r2(g, 3); l[`LGE_pct_${m}`] = mMyo ? r2(100 * g / mMyo) : 0;
      }
      const st = stats[s.indice];
      Object.assign(l, { remote_moyenne: r2(st.moy), remote_ecart_type: r2(st.et), remote_source: st.source, fwhm_maximum: r2(s.fwhmMax) });
      if (s.fcmContraste !== undefined && p.fcmEchelle === "coupe") l.fcm_contraste_sd = s.fcmContraste;
      lignesCoupes.push(l);
      s.poids = poids[s.indice];
      if (cartes[s.indice]) {
        s.idx.forEach((i, j) => {
          const seg = cartes[s.indice][i];
          const d = cumul[seg] || (cumul[seg] = { myo: 0, ...Object.fromEntries(methodes.map((m) => [m, 0])) });
          d.myo += volPx * p.densite;
          for (const m of methodes) d[m] += poids[s.indice][m][j] * volPx * p.densite;
        });
      }
    }
    const lignesSeg = Object.keys(cumul).map(Number).sort((a, b) => a - b).map((seg) => {
      const d = cumul[seg], l = { patient: identifiant, segment: seg, nom: NOMS_SEGMENTS[seg], masse_myocarde_g: r2(d.myo, 3) };
      for (const m of methodes) { l[`LGE_g_${m}`] = r2(d[m], 3); l[`LGE_pct_${m}`] = d.myo ? r2(100 * d[m] / d.myo) : 0; }
      return l;
    });
    const lp = { patient: identifiant, nb_coupes: coupes.length, epaisseur_tranche_mm: r2(tranche), masse_VG_g: r2(totMyo) };
    for (const m of methodes) { lp[`LGE_g_${m}`] = r2(totLge[m]); lp[`LGE_pct_${m}`] = totMyo ? r2(100 * totLge[m] / totMyo) : 0; }
    if (lignesSeg.length) for (const m of methodes) lp[`nb_segments_LGE_${m}`] = lignesSeg.filter((l) => l[`LGE_pct_${m}`] > p.seuilSegmentPct).length;
    Object.assign(lp, { FCM_centres: Array.isArray(infos.centres) ? infos.centres.join(" / ") : infos.centres, FCM_iterations: infos.iterations,
      FCM_converge: infos.converge, FCM_contraste_SD: infos.contraste, FCM_garde_fou_applique: infos.rejete, avertissements: avert.join(" | ") });
    return { patient: lp, coupes: lignesCoupes, segments: lignesSeg, methodes, avertissements: avert, coupesAnalysees: coupes };
  }

  const PARAMETRES_DEFAUT = {
    fcmC: 2, fcmM: 2, fcmClassesRehaussees: 1, fcmEchelle: "patient", fcmGardeFou: 0,
    nsdN: [2, 3, 5], nsdRemote: "contour",
    fwhmFraction: 0.5, fwhmEchelle: "patient", fwhmPercentile: 100,
    densite: 1.05, epaisseur: "auto",
    ahaActif: true, ahaSensInverse: false, seuilSegmentPct: 0,
  };

  return { analyser, fcm, lgeFcm, polygonMask, percentile, preparerCoupe, centreVG, NOMS_SEGMENTS, PARAMETRES_DEFAUT };
})();
if (typeof module !== "undefined") module.exports = LGE;
