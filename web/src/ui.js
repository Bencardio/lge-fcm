/* Interface : lot d'examens, reconnaissance du LGE, file d'analyse, fenêtre patient, exports. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const COUL = { epi: "#3ecf6e", endo: "#ff5a5a", remote: "#4db8ff", rv: "#ffd23f", lge: [255, 61, 187] };
  const NOMS_METH = { FCM_pondere: "FCM pondéré", FCM_defuzzifie: "FCM défuzzifié", FWHM: "FWHM" };
  const nomMeth = (m) => NOMS_METH[m] || m.replace("SD", " SD");
  const fmt = (v, d = 1) => (typeof v === "number" && isFinite(v) ? v.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d }) : "–");
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const pause = () => new Promise((r) => setTimeout(r, 0));

  /* ETAT.contours : contours par image (SOPInstanceUID), partagés par tous les patients. */
  const ETAT = { patients: [], contours: new Map(), ouvert: null, file: [], enCours: false };
  const V = { cur: 0, tool: "nav", mode: "points", zoom: 2, centre: null, contraste: 100, drag: null };

  /* ================================================================ utilitaires */
  let toastT;
  function toast(msg) {
    const t = $("toast"); t.textContent = msg;
    try { t.hidePopover(); t.showPopover(); } catch { t.hidden = false; }
    clearTimeout(toastT); toastT = setTimeout(() => { try { t.hidePopover(); } catch { t.hidden = true; } }, 2600);
  }
  function status(msg, err = false, id = "status") { const s = $(id); s.textContent = msg; s.classList.toggle("err", err); }
  function progression(f) { const p = $("prog"); p.hidden = f === null; if (f !== null) p.firstElementChild.style.width = `${Math.round(100 * f)}%`; }
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
  };
  let dlPromise = null;
  function downloads() {
    if (!window.claude || typeof window.claude.use !== "function") return Promise.resolve(null);
    if (!dlPromise) dlPromise = window.claude.use("downloads").catch(() => null);
    return dlPromise;
  }
  async function enregistrer(nom, data) {
    const dl = await downloads();
    if (dl) {
      try { await dl.save({ filename: nom, data }); toast(`${nom} enregistré`); }
      catch (e) { toast(e && e.code === "declined" ? "Enregistrement annulé" : `Enregistrement impossible (${(e && e.message) || "erreur"})`); }
      return;
    }
    const blob = data instanceof Blob ? data : new Blob([data]);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = nom; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast(`${nom} enregistré`);
  }

  /* ================================================================ paramètres */
  const champs = { fcmC: "p-c", fcmM: "p-m", fcmClassesRehaussees: "p-cr", fcmEchelle: "p-fe", fcmGardeFou: "p-gf", nsdN: "p-n", nsdRemote: "p-rem",
    fwhmFraction: "p-ff", fwhmPercentile: "p-fp", fwhmEchelle: "p-fe2", densite: "p-d", epaisseur: "p-ep", ahaActif: "p-aha", ahaSensInverse: "p-inv", seuilSegmentPct: "p-seuil" };
  function lireParams() {
    const p = {};
    for (const [k, id] of Object.entries(champs)) {
      const el = $(id), d = LGE.PARAMETRES_DEFAUT[k];
      if (el.type === "checkbox") p[k] = el.checked;
      else if (k === "nsdN") p[k] = el.value.split(/[;,\s]+/).map((v) => parseFloat(v)).filter((v) => isFinite(v) && v > 0);
      else if (typeof d === "number") { const v = parseFloat(el.value); p[k] = isFinite(v) ? v : d; }
      else p[k] = el.value;
    }
    if (!p.nsdN.length) p.nsdN = [2, 3, 5];
    if (p.fcmM <= 1) p.fcmM = 1.1;
    p.fcmClassesRehaussees = Math.min(p.fcmClassesRehaussees, p.fcmC - 1);
    return p;
  }
  function ecrireParams(p) {
    for (const [k, id] of Object.entries(champs)) {
      const el = $(id);
      if (el.type === "checkbox") el.checked = !!p[k]; else el.value = k === "nsdN" ? p[k].join(", ") : String(p[k]);
    }
  }
  const motsLGE = () => $("p-mots").value.split(/[;,]+/).map((m) => m.trim().toUpperCase()).filter(Boolean);

  /* ================================================================ lecture DICOM */
  const SYNTAXES_OK = ["1.2.840.10008.1.2", "1.2.840.10008.1.2.1", ""];
  const decodeurs = {};
  function texte(ds, tag) {
    const el = ds.elements[tag];
    if (!el || !el.length) return "";
    const cs = (ds._cs = ds._cs ?? (ds.string("x00080005") || "")), enc = /192/.test(cs) ? "utf-8" : "windows-1252";
    const dec = decodeurs[enc] || (decodeurs[enc] = new TextDecoder(enc));
    return dec.decode(ds.byteArray.subarray(el.dataOffset, el.dataOffset + el.length)).replace(/[\0\s]+$/, "").trim();
  }
  const dateIso = (d) => (/^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d);
  const heure = (t) => (/^\d{4}/.test(t) ? `${t.slice(0, 2)}:${t.slice(2, 4)}` : t);
  const nombre = (s) => { const v = parseFloat(s); return isFinite(v) ? v : ""; };

  function metaExamen(ds) {
    const pn = texte(ds, "x00100010").split("=")[0].split("^");
    return {
      nom: (pn[0] || "").trim(), prenom: (pn[1] || "").trim(), date_naissance: dateIso(texte(ds, "x00100030")), sexe: texte(ds, "x00100040"),
      age: texte(ds, "x00101010"), poids_kg: nombre(texte(ds, "x00101030")), taille_m: nombre(texte(ds, "x00101020")), id_patient: texte(ds, "x00100020"),
      date_examen: dateIso(texte(ds, "x00080020")), heure_examen: heure(texte(ds, "x00080030")), numero_accession: texte(ds, "x00080050"),
      etablissement: texte(ds, "x00080080"), constructeur: texte(ds, "x00080070"), modele: texte(ds, "x00081090"),
      champ_T: nombre(texte(ds, "x00180087")), description_examen: texte(ds, "x00081030"),
    };
  }

  /* Lit uniquement l'en-tête (pas les pixels) : rapide même pour des milliers de fichiers. */
  async function lireEntete(file) {
    if (file.size < 132) return null;
    for (const taille of [262144, file.size]) {
      const buf = new Uint8Array(await file.slice(0, Math.min(taille, file.size)).arrayBuffer());
      if (buf[128] !== 68 || buf[129] !== 73 || buf[130] !== 67 || buf[131] !== 77) return null; // « DICM »
      let ds;
      try { ds = dicomParser.parseDicom(buf, { untilTag: "x7fe00010" }); }
      catch (e) { ds = e && e.dataSet; }
      if (!ds || !ds.elements.x0020000e || !ds.elements.x00080018) { if (taille < file.size) continue; return null; }
      if (!ds.elements.x00280030 || !ds.elements.x00200032) return null; // pas une image positionnée
      const nums = (t) => (ds.string(t) || "").split("\\").map(Number);
      const iop = ds.string("x00200037") ? nums("x00200037") : [1, 0, 0, 0, 1, 0];
      const nrm = [iop[1] * iop[5] - iop[2] * iop[4], iop[2] * iop[3] - iop[0] * iop[5], iop[0] * iop[4] - iop[1] * iop[3]];
      const ipp = nums("x00200032");
      return {
        file, sop: ds.string("x00080018"), serie: ds.string("x0020000e"), etude: ds.string("x0020000d") || "inconnue",
        numero: ds.string("x00200011") || "", description: texte(ds, "x0008103e"), protocole: texte(ds, "x00181030"),
        imageType: ds.string("x00080008") || "", ti: nombre(ds.string("x00180082")), tr: nombre(ds.string("x00180080")), te: nombre(ds.string("x00180081")),
        angle: nombre(ds.string("x00181314")), position: ipp[0] * nrm[0] + ipp[1] * nrm[1] + ipp[2] * nrm[2], normale: nrm.map((v) => Math.round(v * 100) / 100).join(","),
        heure: heure(ds.string("x00080031") || ""), meta: metaExamen(ds),
      };
    }
    return null;
  }

  function lirePixels(buf) {
    const bytes = new Uint8Array(buf);
    let ds;
    try { ds = dicomParser.parseDicom(bytes); } catch { return { erreur: "fichier DICOM illisible" }; }
    const px = ds.elements.x7fe00010;
    if (!px) return { erreur: "image sans pixels" };
    const ts = (ds.string("x00020010") || "").trim();
    if (!SYNTAXES_OK.includes(ts)) return { erreur: `images compressées (syntaxe ${ts}) : exportez les DICOM non compressés` };
    if ((ds.intString("x00280008") || 1) > 1) return { erreur: "DICOM multi-images (« Enhanced ») pas encore pris en charge : exportez en DICOM classique" };
    const rows = ds.uint16("x00280010"), cols = ds.uint16("x00280011"), bits = ds.uint16("x00280100"), signe = ds.uint16("x00280103") === 1;
    const n = rows * cols, brut = bytes.slice(px.dataOffset, px.dataOffset + px.length).buffer;
    let arr;
    if (bits === 16) arr = signe ? new Int16Array(brut, 0, n) : new Uint16Array(brut, 0, n);
    else if (bits === 8) arr = signe ? new Int8Array(brut, 0, n) : new Uint8Array(brut, 0, n);
    else if (bits === 32) arr = signe ? new Int32Array(brut, 0, n) : new Uint32Array(brut, 0, n);
    else return { erreur: `codage ${bits} bits non pris en charge` };
    const pente = parseFloat(ds.string("x00281053") || "1") || 1, ord = parseFloat(ds.string("x00281052") || "0") || 0;
    const image = new Float64Array(n);
    for (let i = 0; i < n; i++) image[i] = arr[i] * pente + ord;
    return { image, rows, cols, spacing: (ds.string("x00280030") || "1\\1").split("\\").map(Number).slice(0, 2), thickness: parseFloat(ds.string("x00180050") || "0") || 0 };
  }

  /* ================================================================ contours (indexés par SOPInstanceUID) */
  const cleDe = (el) => { for (const a of el.attributes) if (a.name.split(":").pop() === "key") return a.value; return ""; };
  const enfants = (el) => [...el.children];
  const enfant = (el, k) => enfants(el).find((c) => cleDe(c) === k);
  function lireCvi42(txt) {
    const xml = new DOMParser().parseFromString(txt, "application/xml");
    const etats = [...xml.getElementsByTagName("*")].find((e) => cleDe(e) === "ImageStates");
    if (!etats) throw new Error("fichier cvi42 non reconnu (pas d'ImageStates)");
    const alias = { endo: ["saendocardialContour"], epi: ["saepicardialContour"], remote: ["saReferenceMyoContour", "saEnhancementReferenceMyoContour"], rv: ["sacardialRefPoint"] };
    let n = 0;
    for (const etat of enfants(etats)) {
      const cont = enfant(etat, "Contours"); if (!cont) continue;
      const lus = {};
      for (const k of enfants(cont)) {
        const res = enfant(k, "SubpixelResolution"), pts = enfant(k, "Points"); if (!pts) continue;
        const r = res ? parseFloat(res.textContent) || 1 : 1;
        lus[cleDe(k)] = enfants(pts).map((p) => [parseFloat(enfant(p, "x")?.textContent) / r, parseFloat(enfant(p, "y")?.textContent) / r]).filter((p) => isFinite(p[0]) && isFinite(p[1]));
      }
      const c = {};
      for (const [champ, noms] of Object.entries(alias)) {
        const nom = noms.find((x) => lus[x] && lus[x].length); if (!nom) continue;
        c[champ] = champ === "rv" ? lus[nom][0] : lus[nom];
      }
      if (Object.keys(c).length) { ETAT.contours.set(cleDe(etat), { ...(ETAT.contours.get(cleDe(etat)) || {}), ...c }); n++; }
    }
    return n;
  }
  function lireJson(txt) {
    const d = JSON.parse(txt); let n = 0;
    const pts = (a) => a.map((p) => [+p[0], +p[1]]);
    for (const e of d.contours || d.coupes || []) {
      if (!e.uid) continue;
      const c = {};
      if (e.endo) c.endo = pts(e.endo); if (e.epi) c.epi = pts(e.epi); if (e.remote) c.remote = pts(e.remote);
      if (e.insertion_vd) c.rv = [+e.insertion_vd[0], +e.insertion_vd[1]]; if (e.niveau) c.niveau = String(e.niveau).toLowerCase();
      ETAT.contours.set(e.uid, c); n++;
    }
    return n;
  }
  async function lireFichiersContours(fichiers) {
    let n = 0;
    for (const f of fichiers) {
      try { const t = await f.text(); n += /\.json$/i.test(f.name) ? lireJson(t) : lireCvi42(t); }
      catch (e) { status(`Contours non lus (${f.name}) : ${e.message}`, true); }
    }
    return n;
  }
  function memoriserContours(s) {
    const c = {};
    if (s.endo && s.endo.length) c.endo = s.endo; if (s.epi && s.epi.length) c.epi = s.epi; if (s.remote && s.remote.length) c.remote = s.remote;
    if (s.rv) c.rv = s.rv; if (s.niveauImpose) c.niveau = s.niveauImpose;
    if (Object.keys(c).length) ETAT.contours.set(s.uid, c); else ETAT.contours.delete(s.uid);
  }

  /* ================================================================ reconnaissance de la séquence LGE */
  const RX = (mots) => new RegExp(`(^|[^A-Z0-9])(${mots})(?=[^A-Z]|$)`);
  const RX_PA = RX("SA|SAX|PA|PETIT|SHORT|SHORTAXIS|SH|COURT|CA");
  const RX_GA = RX("2CH|3CH|4CH|2C|3C|4C|2CV|4CV|LAX|LVOT|GA|GRAND|LONG|VLA|HLA|CH2|CH4|CH3");
  const RX_EXCLU = RX("CINE|CINES|TRUFI|BSSFP|SSFP|FIESTA|BTFE|PERF|PERFUSION|T1MAP|T2MAP|MAP|MOLLI|SHMOLLI|SCOUT|LOC|LOCALIZER|LOCALISER|SURVEY|TISCOUT|LOOK|FLOW|PC|STIR");
  function evaluerSeries(p) {
    const mots = motsLGE(), rxMots = mots.length ? RX(mots.map((m) => m.replace(/[^A-Z0-9]/g, "")).filter(Boolean).join("|")) : null;
    for (const s of Object.values(p.series)) {
      const lib = ` ${s.description} ${s.protocole} `.toUpperCase().replace(/[_\-.]+/g, " ");
      s.motTrouve = rxMots ? (lib.match(rxMots) || [])[2] || "" : "";
      s.petitAxe = RX_PA.test(lib); s.grandAxe = RX_GA.test(lib); s.exclu = RX_EXCLU.test(lib);
      s.nbContours = s.sops.filter((u) => ETAT.contours.has(u)).length;
      let sc = 0;
      if (s.nbContours) sc += 10000 + s.nbContours;
      if (s.motTrouve) sc += 1000;
      if (s.exclu) sc -= 900;
      if (s.nbImages > 3 * s.nbCoupes) sc -= 500; // plusieurs phases par coupe : ciné, pas LGE
      sc += s.nbCoupes >= 5 ? 300 : s.nbCoupes >= 3 ? 100 : 0;
      if (s.petitAxe) sc += 50; if (s.grandAxe) sc -= 200;
      if (/MAG/.test(lib)) sc -= 5;
      s.score = sc + Math.min(s.nbCoupes, 40);
    }
    const tri = Object.values(p.series).sort((a, b) => b.score - a.score);
    p.serieAuto = tri.length && tri[0].score >= 1000 ? tri[0].uid : null;
  }

  /* ================================================================ lot de patients */
  function creerPatients(entetes) {
    const parEtude = new Map();
    for (const h of entetes) { if (!parEtude.has(h.etude)) parEtude.set(h.etude, []); parEtude.get(h.etude).push(h); }
    const nouveaux = [];
    for (const [etude, hs] of parEtude) {
      let p = ETAT.patients.find((x) => x.etude === etude);
      if (!p) { p = { etude, series: {}, meta: hs[0].meta, statut: "attente", jeton: 0, slices: null, result: null, corrige: false, valide: false, serieManuelle: false }; ETAT.patients.push(p); }
      for (const h of hs) {
        const s = p.series[h.serie] || (p.series[h.serie] = { uid: h.serie, numero: h.numero, description: h.description, protocole: h.protocole, heure: h.heure,
          ti: h.ti, tr: h.tr, te: h.te, angle: h.angle, fichiers: [], sops: [], positions: new Set(), nbImages: 0, nbCoupes: 0 });
        if (s.sops.includes(h.sop)) continue;
        s.fichiers.push(h); s.sops.push(h.sop); s.positions.add(`${h.normale}|${h.position.toFixed(1)}`);
        s.nbImages = s.fichiers.length; s.nbCoupes = s.positions.size;
      }
      nouveaux.push(p);
    }
    ETAT.patients.sort((a, b) => `${a.meta.date_examen} ${a.meta.nom}`.localeCompare(`${b.meta.date_examen} ${b.meta.nom}`));
    ETAT.patients.forEach((p, i) => (p.id = `P${String(i + 1).padStart(3, "0")}`));
    return nouveaux;
  }

  async function ouvrir(fichiers) {
    fichiers = [...fichiers].filter((f) => !f.name.startsWith("."));
    if (!fichiers.length) return;
    if (ETAT.patients.some((p) => p.demo)) { ETAT.patients = []; ETAT.contours.clear(); ETAT.file = []; }
    const contours = fichiers.filter((f) => /\.(json|xml|cvi42wsx|cvi42ws)$/i.test(f.name));
    const autres = fichiers.filter((f) => !contours.includes(f) && !/\.(png|jpe?g|gif|pdf|txt|csv|xlsx?|docx?|mat|npz|npy|zip|html?|py|ini|md)$/i.test(f.name));
    if (contours.length) await lireFichiersContours(contours);
    const entetes = [];
    let fait = 0;
    const t0 = performance.now();
    const travail = async () => {
      while (autres.length) {
        const f = autres.pop();
        try { const h = await lireEntete(f); if (h) entetes.push(h); } catch { /* fichier ignoré */ }
        if (++fait % 50 === 0) { progression(fait / (fait + autres.length)); status(`Lecture des en-têtes : ${fait} fichiers…`); }
      }
    };
    progression(0);
    await Promise.all(Array.from({ length: 8 }, travail));
    progression(null);
    if (!entetes.length) { status("Aucune image DICOM trouvée dans ces fichiers.", true); majListe(); return; }
    const nouveaux = creerPatients(entetes);
    for (const p of nouveaux) { if (!p.serieManuelle) { evaluerSeries(p); p.serieUid = p.serieAuto; } mettreEnFile(p); }
    status(`${entetes.length} images lues en ${((performance.now() - t0) / 1000).toFixed(1)} s : ${nouveaux.length} examen(s). Analyse en cours…`);
    majListe(); traiterFile();
  }

  function mettreEnFile(p, prioritaire = false) {
    if (!ETAT.file.includes(p)) prioritaire ? ETAT.file.unshift(p) : ETAT.file.push(p);
    if (p.statut !== "run") p.statut = "attente";
  }

  async function chargerSerie(p, uid) {
    const s = p.series[uid];
    if (s.synth) return s.synth();
    const infos = [];
    const triees = [...s.fichiers].sort((a, b) => a.position - b.position);
    for (const h of triees) {
      const d = lirePixels(await h.file.arrayBuffer());
      if (d.erreur) throw new Error(d.erreur);
      infos.push({ ...d, position: h.position, uid: h.sop, normale: h.normale });
      if (infos.length % 10 === 0) await pause();
    }
    // une seule orientation : celle qui a le plus d'images ; une image par position
    const parNormale = {}; for (const d of infos) (parNormale[d.normale] = parNormale[d.normale] || []).push(d);
    const choix = Object.values(parNormale).sort((a, b) => b.length - a.length)[0];
    const coupes = [];
    for (const d of choix) { if (coupes.length && Math.abs(d.position - coupes[coupes.length - 1].position) < 1e-3) continue; coupes.push(d); }
    return coupes.map((d, i) => ({ ...d, indice: i }));
  }

  function appliquerContours(slices) {
    for (const s of slices) {
      const c = ETAT.contours.get(s.uid) || {};
      const cp = (a) => (a ? a.map((x) => [...x]) : null);
      s.endo = cp(c.endo); s.epi = cp(c.epi); s.remote = cp(c.remote); s.rv = c.rv ? [...c.rv] : null; s.niveauImpose = c.niveau || null;
    }
  }

  const aContours = (slices) => slices.some((s) => s.epi && s.endo && s.epi.length >= 3 && s.endo.length >= 3);
  function calculer(p) {
    p.result = null; p.erreur = null;
    for (const s of p.slices) { s.myo = null; s.poids = null; s.carte = null; s.remoteAuto = null; s.niveau = null; }
    if (!aContours(p.slices)) { p.statut = "todo"; return; }
    try { p.result = LGE.analyser(p.slices, lireParams(), p.id); p.statut = "ok"; }
    catch (e) { p.erreur = e.message; p.statut = "err"; }
  }

  async function analyserPatient(p) {
    const jeton = ++p.jeton;
    if (!p.serieUid) { p.statut = "noseq"; p.result = null; p.slices = null; return; }
    p.statut = "run"; majLigne(p);
    try {
      const slices = await chargerSerie(p, p.serieUid);
      if (jeton !== p.jeton) return; // la séquence a changé entre-temps
      appliquerContours(slices); p.slices = slices; calculer(p);
    } catch (e) { if (jeton === p.jeton) { p.statut = "err"; p.erreur = e.message; p.result = null; } }
    if (p !== ETAT.ouvert) p.slices = null; // libère la mémoire : les images sont relues à l'ouverture
  }

  async function traiterFile() {
    if (ETAT.enCours) return;
    ETAT.enCours = true;
    while (ETAT.file.length) {
      const p = ETAT.file.shift();
      await analyserPatient(p);
      majLigne(p); majResume();
      if (p === ETAT.ouvert) afficherFenetre();
      await pause();
    }
    ETAT.enCours = false; majResume();
  }

  /* ================================================================ liste des patients */
  const STATUTS = {
    attente: ["En attente", "run"], run: ["Analyse…", "run"], ok: ["Mesuré", "ok"], todo: ["Contours à tracer", "todo"],
    noseq: ["LGE non trouvé", "todo"], err: ["Erreur", "err"], corr: ["Corrigé", "ok"], val: ["Validé", "val"],
  };
  function statutDe(p) { if (p.valide && p.statut === "ok") return "val"; if (p.corrige && p.statut === "ok") return "corr"; return p.statut; }
  const chip = (p) => { const [t, c] = STATUTS[statutDe(p)]; return `<span class="chip ${c}" title="${esc(p.erreur || "")}">${t}</span>`; };
  const nomPatient = (p) => [p.meta.nom, p.meta.prenom].filter(Boolean).join(" ") || p.meta.id_patient || p.id;

  function ligneHtml(p) {
    const s = p.serieUid ? p.series[p.serieUid] : null, P = p.result && p.result.patient;
    const pc = (m) => (P && P[`LGE_pct_${m}`] !== undefined ? fmt(P[`LGE_pct_${m}`], 1) : "");
    return `<td>${chip(p)}</td><td><b>${esc(nomPatient(p))}</b><div class="sub">${esc(p.id)} · ${esc(p.meta.date_examen || "")}</div></td>
      <td>${s ? `${esc(s.description || "sans nom")}<div class="sub">n° ${esc(s.numero)} · ${s.nbCoupes} coupes · ${p.serieManuelle ? "choix manuel" : "choix auto"}</div>` : `<span class="sub">à choisir</span>`}</td>
      <td class="n">${P ? fmt(P.masse_VG_g, 1) : ""}</td><td class="n">${pc("FCM_pondere")}</td><td class="n">${pc("FCM_defuzzifie")}</td>
      <td class="n">${pc("3SD")}</td><td class="n">${pc("5SD")}</td><td class="n">${pc("FWHM")}</td>`;
  }
  function majListe() {
    const t = $("t-patients");
    if (!ETAT.patients.length) { t.innerHTML = `<tr><td class="hint">Aucun examen chargé. Ouvrez le dossier qui contient vos examens.</td></tr>`; majResume(); return; }
    t.innerHTML = `<thead><tr><th>Statut</th><th>Patient</th><th>Séquence retenue</th><th class="n">VG (g)</th><th class="n">FCM pond. %</th><th class="n">FCM déf. %</th><th class="n">3 SD %</th><th class="n">5 SD %</th><th class="n">FWHM %</th></tr></thead><tbody>` +
      ETAT.patients.map((p) => `<tr data-etude="${esc(p.etude)}" tabindex="0">${ligneHtml(p)}</tr>`).join("") + "</tbody>";
    t.querySelectorAll("tbody tr").forEach((tr) => {
      const ouvrirLigne = () => ouvrirPatient(ETAT.patients.find((p) => p.etude === tr.dataset.etude));
      tr.onclick = ouvrirLigne; tr.onkeydown = (e) => { if (e.key === "Enter") ouvrirLigne(); };
    });
    majResume();
  }
  function majLigne(p) {
    const tr = [...document.querySelectorAll("#t-patients tbody tr")].find((x) => x.dataset.etude === p.etude);
    if (tr) tr.innerHTML = ligneHtml(p); else majListe();
  }
  function majResume() {
    const n = ETAT.patients.length, c = (st) => ETAT.patients.filter((p) => statutDe(p) === st).length;
    const enCours = ETAT.file.length + ETAT.patients.filter((p) => p.statut === "run").length;
    $("resume-lot").textContent = n ? `${n} examen(s) : ${c("ok") + c("corr") + c("val")} mesuré(s) dont ${c("val")} validé(s), ${c("todo")} à contourer, ${c("noseq")} sans LGE reconnu, ${c("err")} en erreur${enCours ? `, ${enCours} en cours d'analyse` : ""}.` : "";
    $("b-excel").disabled = !n; $("b-save-contours").disabled = !ETAT.contours.size;
    if (!enCours && n && /Analyse en cours/.test($("status").textContent)) status("Analyse terminée.");
  }

  /* ================================================================ fenêtre patient */
  const fen = $("fen");
  async function ouvrirPatient(p) {
    if (!p) return;
    const ancien = ETAT.ouvert;
    if (ancien && ancien !== p && !ETAT.file.includes(ancien)) ancien.slices = null;
    ETAT.ouvert = p; V.cur = 0; V.centre = null; p.pile = [];
    if (!fen.open) fen.showModal();
    majSelectSerie(); afficherFenetre();
    if (!p.slices && p.serieUid && p.statut !== "run") {
      status("Chargement des images…", false, "fen-status");
      const jeton = p.jeton;
      try {
        const slices = await chargerSerie(p, p.serieUid);
        if (ETAT.ouvert !== p || jeton !== p.jeton) return;
        appliquerContours(slices); p.slices = slices; calculer(p); majLigne(p);
      } catch (e) { p.statut = "err"; p.erreur = e.message; majLigne(p); }
      V.cur = Math.floor((p.slices || []).length / 2);
      afficherFenetre();
    } else if (p.slices) { V.cur = Math.floor(p.slices.length / 2); afficherFenetre(); }
  }
  function fermerFenetre() {
    const p = ETAT.ouvert; ETAT.ouvert = null;
    if (p && !ETAT.file.includes(p) && p.statut !== "run") p.slices = null;
    if (fen.open) fen.close();
  }
  function majSelectSerie() {
    const p = ETAT.ouvert; if (!p) return;
    const sel = $("serie");
    const series = Object.values(p.series).sort((a, b) => (parseInt(a.numero) || 0) - (parseInt(b.numero) || 0));
    sel.innerHTML = (p.serieUid ? "" : `<option value="">Choisissez la séquence LGE…</option>`) + series.map((s) => {
      const tags = [s.uid === p.serieAuto ? "choix auto" : "", s.motTrouve ? `« ${s.motTrouve} »` : "", s.nbContours ? "contours" : ""].filter(Boolean).join(", ");
      return `<option value="${esc(s.uid)}">n° ${esc(s.numero || "?")} · ${esc(s.description || s.protocole || "sans nom")} (${s.nbCoupes} coupe${s.nbCoupes > 1 ? "s" : ""}, ${s.nbImages} images)${tags ? " · " + esc(tags) : ""}</option>`;
    }).join("");
    sel.value = p.serieUid || "";
  }
  function afficherFenetre() {
    const p = ETAT.ouvert; if (!p) return;
    $("fen-nom").textContent = `${nomPatient(p)} · ${p.id}`;
    $("fen-statut").innerHTML = chip(p);
    const m = p.meta, s = p.serieUid ? p.series[p.serieUid] : null;
    $("fen-meta").innerHTML = [["Né(e) le", m.date_naissance], ["Sexe", m.sexe], ["Examen", `${m.date_examen} ${m.heure_examen}`], ["Machine", [m.constructeur, m.modele, m.champ_T ? `${m.champ_T} T` : ""].filter(Boolean).join(" ")], ["Centre", m.etablissement], ["TI", s && s.ti ? `${s.ti} ms` : ""]]
      .filter(([, v]) => v && String(v).trim()).map(([k, v]) => `<span>${k} <b>${esc(v)}</b></span>`).join("");
    $("b-annuler").disabled = !(p.pile && p.pile.length);
    $("b-valider").textContent = p.valide ? "Annuler la validation" : "Valider les mesures";
    $("b-valider").disabled = !p.result;
    const i = ETAT.patients.indexOf(p); $("b-prec").disabled = i <= 0; $("b-suiv").disabled = i >= ETAT.patients.length - 1;
    const msg = p.statut === "run" ? "Analyse en cours…" : p.statut === "noseq" ? "Aucune séquence ne contient les mots recherchés : choisissez la séquence LGE dans la liste." : p.statut === "err" ? `Erreur : ${p.erreur}` : p.statut === "todo" ? "Pas de contours pour cette séquence : tracez l'épicarde et l'endocarde, ou chargez un export cvi42." : "";
    status(msg, p.statut === "err", "fen-status");
    $("empty").hidden = !!(p.slices && p.slices.length);
    $("empty").textContent = p.serieUid ? "Chargement des images…" : "Choisissez une séquence.";
    majBandeau(); majOptions(); dessiner(); afficherResultats();
  }

  /* ---------------------------------------------------------------- bandeau des coupes */
  function majBandeau() {
    const el = $("slices"); el.innerHTML = "";
    const sl = (ETAT.ouvert && ETAT.ouvert.slices) || [];
    sl.forEach((s, i) => {
      const b = document.createElement("button");
      b.className = "slice" + (i === V.cur ? " on" : ""); b.setAttribute("role", "tab"); b.setAttribute("aria-selected", i === V.cur);
      const ok = s.epi && s.endo && s.epi.length >= 3 && s.endo.length >= 3, part = !ok && ((s.epi && s.epi.length) || (s.endo && s.endo.length));
      const niv = s.niveau ? { basal: "base", median: "médian", apical: "apex" }[s.niveau] : "";
      b.innerHTML = `<span>${i + 1}</span><i class="st ${ok ? "ok" : part ? "part" : ""}"></i><small>${niv || "&nbsp;"}</small>`;
      b.title = ok ? "Contours complets" : part ? "Contours incomplets" : "Pas de contours";
      b.onclick = () => { V.cur = i; majBandeau(); dessiner(); };
      el.appendChild(b);
    });
    const s = sl[V.cur];
    $("slice-info").textContent = s ? `Coupe ${V.cur + 1} / ${sl.length} · ${fmt(s.spacing[0], 2)} × ${fmt(s.spacing[1], 2)} mm · épaisseur ${fmt(s.thickness, 1)} mm` : "";
  }

  /* ---------------------------------------------------------------- visionneuse */
  const cv = $("cv"), ctx = cv.getContext("2d"), off = document.createElement("canvas"), octx = off.getContext("2d");
  const W = cv.width;
  const courante = () => (ETAT.ouvert && ETAT.ouvert.slices ? ETAT.ouvert.slices[V.cur] : null);
  function vue(s) {
    const fit = W / Math.max(s.rows, s.cols), echelle = fit * V.zoom;
    let centre = V.centre;
    if (!centre) {
      const ref = [s, ...ETAT.ouvert.slices].find((x) => x.endo && x.endo.length >= 3);
      centre = V.zoom > 1 && ref ? LGE.centreVG(ref) : [(s.cols - 1) / 2, (s.rows - 1) / 2];
    }
    return { echelle, cx: centre[0], cy: centre[1] };
  }
  const versEcran = (v, x, y) => [(x - v.cx) * v.echelle + W / 2, (y - v.cy) * v.echelle + W / 2];
  const versImage = (v, X, Y) => [(X - W / 2) / v.echelle + v.cx, (Y - W / 2) / v.echelle + v.cy];
  const fenetres = new WeakMap();
  function fenetre(s) {
    if (!fenetres.has(s)) { const e = s.image.filter((_, i) => i % 3 === 0); fenetres.set(s, [LGE.percentile(e, 1), LGE.percentile(e, 99.5)]); }
    const [lo, hi] = fenetres.get(s);
    return [lo, lo + (hi - lo) * 100 / V.contraste];
  }
  const COUL_SEG = ["#6b8cff", "#45c4b0", "#ffb84d", "#e86f9c", "#9f7aea", "#7ccf55"];
  const hot = (w) => [Math.min(255, w * 3 * 255), Math.min(255, Math.max(0, (w * 3 - 1) * 255)), Math.min(255, Math.max(0, (w * 3 - 2) * 255))];

  function dessiner() {
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--scan").trim() || "#000";
    ctx.fillRect(0, 0, W, W);
    const s = courante(); if (!s) return;
    off.width = s.cols; off.height = s.rows;
    const id = octx.createImageData(s.cols, s.rows), d = id.data, [lo, hi] = fenetre(s);
    for (let i = 0; i < s.image.length; i++) { const g = Math.max(0, Math.min(255, ((s.image[i] - lo) / (hi - lo || 1)) * 255)); d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = g; d[i * 4 + 3] = 255; }
    const ov = $("overlay").value;
    if (s.poids && s.idx && ov !== "aucune") {
      if (ov === "aha" && s.carte) {
        for (const i of s.idx) { const c = COUL_SEG[(s.carte[i] - 1) % 6]; const rgb = [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16)); for (let k = 0; k < 3; k++) d[i * 4 + k] = d[i * 4 + k] * 0.45 + rgb[k] * 0.55; }
      } else if (s.poids[ov]) {
        const w = s.poids[ov];
        s.idx.forEach((i, j) => {
          if (ov === "FCM_pondere") { const c = hot(w[j]), a = 0.25 + 0.6 * w[j]; for (let k = 0; k < 3; k++) d[i * 4 + k] = d[i * 4 + k] * (1 - a) + c[k] * a; }
          else if (w[j] > 0.5) for (let k = 0; k < 3; k++) d[i * 4 + k] = d[i * 4 + k] * 0.35 + COUL.lge[k] * 0.65;
        });
      }
    }
    octx.putImageData(id, 0, 0);
    const v = vue(s);
    ctx.imageSmoothingEnabled = false;
    const [x0, y0] = versEcran(v, -0.5, -0.5);
    ctx.drawImage(off, x0, y0, s.cols * v.echelle, s.rows * v.echelle);
    if (ov === "aha" && s.carte && s.idx) {
      const somme = {};
      for (const i of s.idx) { const k = s.carte[i]; const e = somme[k] || (somme[k] = [0, 0, 0]); e[0] += i % s.cols; e[1] += Math.floor(i / s.cols); e[2]++; }
      ctx.font = "600 13px 'IBM Plex Mono', monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      for (const [k, e] of Object.entries(somme)) { const [X, Y] = versEcran(v, e[0] / e[2], e[1] / e[2]); ctx.fillStyle = "rgba(0,0,0,.6)"; ctx.fillRect(X - 12, Y - 9, 24, 18); ctx.fillStyle = "#fff"; ctx.fillText(k, X, Y + 1); }
    }
    if ($("show-contours").checked) {
      const poly = (pts, coul, actif) => {
        if (!pts || !pts.length) return;
        ctx.strokeStyle = coul; ctx.lineWidth = actif ? 2 : 1.5; ctx.beginPath();
        pts.forEach((p, k) => { const [X, Y] = versEcran(v, p[0], p[1]); k ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
        if (pts.length >= 3) ctx.closePath(); ctx.stroke();
        if (actif) { ctx.fillStyle = coul; for (const p of pts) { const [X, Y] = versEcran(v, p[0], p[1]); ctx.fillRect(X - 3, Y - 3, 6, 6); } }
      };
      poly(s.epi, COUL.epi, V.tool === "epi"); poly(s.endo, COUL.endo, V.tool === "endo"); poly(s.remote, COUL.remote, V.tool === "remote");
      if (!s.remote && s.remoteAuto && V.tool === "nav") {
        ctx.fillStyle = "rgba(77,184,255,.35)";
        for (let i = 0; i < s.remoteAuto.length; i++) if (s.remoteAuto[i]) { const [X, Y] = versEcran(v, i % s.cols - 0.5, Math.floor(i / s.cols) - 0.5); ctx.fillRect(X, Y, v.echelle, v.echelle); }
      }
      if (s.rv) { const [X, Y] = versEcran(v, s.rv[0], s.rv[1]); ctx.fillStyle = COUL.rv; ctx.beginPath(); ctx.arc(X, Y, 5, 0, 2 * Math.PI); ctx.fill(); ctx.strokeStyle = "#000"; ctx.lineWidth = 1; ctx.stroke(); }
    }
    if (V.drag && V.drag.type === "libre" && V.drag.pts.length > 1) {
      ctx.strokeStyle = COUL[V.tool] || "#fff"; ctx.lineWidth = 2; ctx.setLineDash([5, 4]); ctx.beginPath();
      V.drag.pts.forEach((p, k) => { const [X, Y] = versEcran(v, p[0], p[1]); k ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
      ctx.stroke(); ctx.setLineDash([]);
    }
    const R = ETAT.ouvert.result;
    if (s.poids && ov !== "aucune" && ov !== "aha" && R) {
      const l = R.coupes.find((c) => c.coupe === s.indice);
      if (l && l[`LGE_pct_${ov}`] !== undefined) {
        ctx.font = "500 14px 'IBM Plex Mono', monospace"; ctx.textAlign = "left"; ctx.textBaseline = "top";
        const txt = `${nomMeth(ov)} : ${fmt(l[`LGE_g_${ov}`], 2)} g · ${fmt(l[`LGE_pct_${ov}`], 1)} %`;
        ctx.fillStyle = "rgba(0,0,0,.6)"; ctx.fillRect(8, 8, ctx.measureText(txt).width + 16, 24); ctx.fillStyle = "#fff"; ctx.fillText(txt, 16, 13);
      }
    }
  }

  /* ---------------------------------------------------------------- tracé et corrections */
  const CONTOURS_POLY = ["epi", "endo", "remote"];
  const NOMS_CONT = { epi: "l'épicarde", endo: "l'endocarde", remote: "le myocarde sain", rv: "l'insertion du VD" };
  const AIDES = {
    nav: "Glissez pour déplacer l'image. Flèches haut et bas : coupe suivante ou précédente.",
    rv: "Cliquez sur le point d'insertion antérieur du VD. Il oriente les segments AHA.",
    points: "Cliquez pour poser les points. Sur un contour déjà fermé, chaque clic ajoute un point sur le segment le plus proche. Glissez un point pour le déplacer, clic droit ou Alt + clic pour le supprimer.",
    cercle: "Cliquez au centre du VG puis glissez jusqu'au bord : le cercle remplace le contour. Passez ensuite en mode Points pour l'ajuster.",
    libre: "Dessinez le contour en maintenant le bouton enfoncé. Pour retoucher une partie seulement, partez du contour existant et revenez-y : seul le morceau entre les deux est remplacé.",
  };
  const cp = (a) => (a ? a.map((x) => [...x]) : null);
  function choisirOutil(t) {
    V.tool = t;
    for (const b of document.querySelectorAll("#tools .tool")) b.setAttribute("aria-pressed", b.dataset.tool === t);
    const poly = CONTOURS_POLY.includes(t);
    $("modes").hidden = !poly;
    $("tool-hint").textContent = poly ? AIDES[V.mode] : AIDES[t];
    $("lbl-prop").firstChild.textContent = t === "nav" ? "Propager tous les contours de cette coupe" : `Propager ${NOMS_CONT[t]} de cette coupe`;
    dessiner();
  }
  function choisirMode(m) {
    V.mode = m;
    for (const b of document.querySelectorAll("#modes button")) b.setAttribute("aria-pressed", b.dataset.mode === m);
    choisirOutil(V.tool);
  }
  function posCanvas(e) { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * W / r.height]; }
  function distSeg(p, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy; let t = l ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); }
  const cercle = (c, r, n = 48) => Array.from({ length: n }, (_, k) => [c[0] + r * Math.cos(2 * Math.PI * k / n), c[1] - r * Math.sin(2 * Math.PI * k / n)]);

  /* annuler : instantané de tous les contours du patient avant chaque modification */
  function instantane() {
    const p = ETAT.ouvert; if (!p || !p.slices) return;
    p.pile = p.pile || [];
    p.pile.push(p.slices.map((s) => ({ endo: cp(s.endo), epi: cp(s.epi), remote: cp(s.remote), rv: s.rv ? [...s.rv] : null })));
    if (p.pile.length > 40) p.pile.shift();
    $("b-annuler").disabled = false;
  }
  function annuler() {
    const p = ETAT.ouvert; if (!p || !p.slices || !p.pile || !p.pile.length) return;
    const etat = p.pile.pop();
    p.slices.forEach((s, i) => Object.assign(s, etat[i]));
    modifie(true); $("b-annuler").disabled = !p.pile.length;
  }

  /* main levée : rééchantillonne le tracé (un point par pixel environ) */
  function reechantillonner(pts, pas = 1) {
    const out = [pts[0]];
    for (const q of pts.slice(1)) { const d = out[out.length - 1]; if (Math.hypot(q[0] - d[0], q[1] - d[1]) >= pas) out.push(q); }
    return out;
  }
  function finirMainLevee(s, trace, v) {
    const S = reechantillonner(trace, 1);
    if (S.length < 3) return;
    const C = s[V.tool];
    if (C && C.length >= 3) {
      const proche = (pt) => { let k = -1, d = Infinity; C.forEach((c, i) => { const dd = Math.hypot(c[0] - pt[0], c[1] - pt[1]); if (dd < d) { d = dd; k = i; } }); return [k, d * v.echelle]; };
      const [ia, da] = proche(S[0]), [ib, db] = proche(S[S.length - 1]);
      if (da < 14 && db < 14 && ia !== ib) {
        // retouche partielle : on remplace le plus court des deux arcs entre les extrémités du tracé
        const arc = (i, j) => { const r = [C[i]]; let k = i; while (k !== j) { k = (k + 1) % C.length; r.push(C[k]); } return r; };
        const lg = (a) => a.slice(1).reduce((t, q, k) => t + Math.hypot(q[0] - a[k][0], q[1] - a[k][1]), 0);
        const aller = arc(ia, ib), retour = arc(ib, ia);
        s[V.tool] = lg(aller) <= lg(retour) ? [...retour, ...S.slice(1, -1)] : [...aller, ...S.slice(1, -1).reverse()];
        return;
      }
    }
    s[V.tool] = reechantillonner(S, 1.5);
  }

  cv.addEventListener("contextmenu", (e) => e.preventDefault());
  cv.addEventListener("pointerdown", (e) => {
    const s = courante(); if (!s) return;
    const v = vue(s), P = posCanvas(e), I = versImage(v, P[0], P[1]);
    cv.setPointerCapture(e.pointerId);
    if (V.tool === "nav" || e.button === 1) { V.drag = { type: "pan", P, centre: [v.cx, v.cy] }; return; }
    instantane();
    if (V.tool === "rv") { s.rv = I; modifie(); return; }
    const pts = s[V.tool] || [];
    let proche = -1, dmin = 9;
    pts.forEach((p, k) => { const [X, Y] = versEcran(v, p[0], p[1]); const dd = Math.hypot(X - P[0], Y - P[1]); if (dd < dmin) { dmin = dd; proche = k; } });
    if (e.button === 2 || e.altKey) { if (proche >= 0) { pts.splice(proche, 1); s[V.tool] = pts; modifie(); } else ETAT.ouvert.pile.pop(); return; }
    if (V.mode === "cercle") { V.drag = { type: "cercle", c: I }; return; }
    if (V.mode === "libre") { V.drag = { type: "libre", pts: [I] }; return; }
    s[V.tool] = pts;
    if (proche >= 0) { V.drag = { type: "pt", k: proche }; return; }
    if (pts.length >= 3) {
      // contour fermé : le nouveau point s'insère sur le segment le plus proche
      const ecr = pts.map((p) => versEcran(v, p[0], p[1]));
      let best = 0, dbest = Infinity;
      for (let k = 0; k < ecr.length; k++) { const dd = distSeg(P, ecr[k], ecr[(k + 1) % ecr.length]); if (dd < dbest) { dbest = dd; best = k; } }
      pts.splice(best + 1, 0, I); V.drag = { type: "pt", k: best + 1 }; modifie(); return;
    }
    pts.push(I); V.drag = { type: "pt", k: pts.length - 1 }; modifie();
  });
  cv.addEventListener("pointermove", (e) => {
    if (!V.drag) return;
    const s = courante(); if (!s) return;
    const v = vue(s), P = posCanvas(e), I = versImage(v, P[0], P[1]);
    if (V.drag.type === "pan") { V.centre = [V.drag.centre[0] - (P[0] - V.drag.P[0]) / v.echelle, V.drag.centre[1] - (P[1] - V.drag.P[1]) / v.echelle]; dessiner(); return; }
    if (V.drag.type === "cercle") { const r = Math.hypot(I[0] - V.drag.c[0], I[1] - V.drag.c[1]); if (r > 0.5) s[V.tool] = cercle(V.drag.c, r); dessiner(); return; }
    if (V.drag.type === "libre") { V.drag.pts.push(I); dessiner(); return; }
    s[V.tool][V.drag.k] = I; dessiner();
  });
  const finDrag = () => {
    const d = V.drag; V.drag = null;
    if (!d) return;
    const s = courante();
    if (d.type === "libre" && s) finirMainLevee(s, d.pts, vue(s));
    if (d.type !== "pan") modifie();
  };
  cv.addEventListener("pointerup", finDrag); cv.addEventListener("pointercancel", finDrag);

  /* propagation : la forme corrigée est recentrée et remise à l'échelle de chaque coupe cible */
  function geom(pts) {
    if (!pts || pts.length < 3) return null;
    const cx = pts.reduce((t, p) => t + p[0], 0) / pts.length, cy = pts.reduce((t, p) => t + p[1], 0) / pts.length;
    return { c: [cx, cy], r: pts.reduce((t, p) => t + Math.hypot(p[0] - cx, p[1] - cy), 0) / pts.length };
  }
  function propager() {
    const p = ETAT.ouvert, sl = p && p.slices, src = courante(); if (!src) return;
    const types = V.tool === "nav" ? ["epi", "endo", "remote", "rv"] : [V.tool];
    if (!types.some((t) => (t === "rv" ? src.rv : src[t] && src[t].length >= 3))) { toast("Rien à propager sur cette coupe"); return; }
    const mode = $("prop-cible").value;
    const cibles = sl.filter((s) => s !== src && (mode !== "voisines" || Math.abs(s.indice - src.indice) === 1));
    instantane();
    let n = 0;
    for (const t of cibles) {
      let touche = false;
      for (const ty of types) {
        const a = ty === "rv" ? src.rv : src[ty];
        if (!a || (ty !== "rv" && a.length < 3)) continue;
        const existe = ty === "rv" ? !!t.rv : t[ty] && t[ty].length >= 3;
        if (mode === "vides" && existe) continue;
        // repère : le même contour s'il existe déjà sur la cible, sinon l'épicarde, sinon l'endocarde
        let gs = null, gt = null;
        for (const ref of ty === "rv" || ty === "remote" ? ["epi", "endo"] : [ty, "epi", "endo"]) { gs = geom(src[ref]); gt = geom(t[ref]); if (gs && gt) break; gs = gt = null; }
        const f = (q) => (gs && gt ? [gt.c[0] + (q[0] - gs.c[0]) * gt.r / gs.r, gt.c[1] + (q[1] - gs.c[1]) * gt.r / gs.r] : [...q]);
        if (ty === "rv") t.rv = f(a); else t[ty] = a.map(f);
        touche = true;
      }
      if (touche) n++;
    }
    if (!n) { p.pile.pop(); toast("Aucune coupe à compléter"); return; }
    modifie(true); toast(`Contours propagés sur ${n} coupe(s). Bouton Annuler pour revenir en arrière.`);
  }

  let analyseT;
  function modifie(toutes = false) {
    const p = ETAT.ouvert, s = courante(); if (!p || !s) return;
    for (const x of toutes ? p.slices : [s]) memoriserContours(x);
    p.corrige = true; p.valide = false;
    dessiner(); majBandeau();
    clearTimeout(analyseT);
    analyseT = setTimeout(() => { if (ETAT.ouvert !== p || !p.slices) return; calculer(p); majLigne(p); majResume(); afficherFenetre(); }, 150);
  }

  fen.addEventListener("keydown", (e) => {
    if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    const sl = (ETAT.ouvert && ETAT.ouvert.slices) || []; if (!sl.length) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); annuler(); return; }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); V.cur = Math.max(0, Math.min(sl.length - 1, V.cur + (e.key === "ArrowUp" ? -1 : 1))); majBandeau(); dessiner(); }
  });

  /* ---------------------------------------------------------------- résultats du patient */
  function majOptions() {
    const R = ETAT.ouvert && ETAT.ouvert.result;
    const meths = R ? R.methodes : ["FCM_pondere", "FCM_defuzzifie", ...lireParams().nsdN.map((n) => `${n}SD`), "FWHM"];
    const sel = $("overlay"), avant = sel.value || "FCM_pondere";
    sel.innerHTML = `<option value="aucune">Aucune</option>` + meths.map((m) => `<option value="${m}">${nomMeth(m)}</option>`).join("") + `<option value="aha">Segments AHA</option>`;
    sel.value = [...sel.options].some((o) => o.value === avant) ? avant : "FCM_pondere";
    const b = $("bull-meth"), bav = b.value || "FCM_pondere";
    b.innerHTML = meths.map((m) => `<option value="${m}">${nomMeth(m)}</option>`).join("");
    b.value = meths.includes(bav) ? bav : meths[0];
  }
  function afficherResultats() {
    const p = ETAT.ouvert, R = p && p.result, warn = $("warn");
    warn.innerHTML = "";
    if (!R) {
      ["r-vg", "r-nc", "r-cent"].forEach((k) => ($(k).textContent = "–"));
      $("t-meth").innerHTML = `<tr><td class="hint">Les mesures apparaîtront dès qu'au moins une coupe aura ses contours épicarde et endocarde.</td></tr>`;
      $("t-coupes").innerHTML = ""; $("bull").innerHTML = ""; return;
    }
    const P = R.patient;
    $("r-vg").textContent = `${fmt(P.masse_VG_g, 1)} g`; $("r-nc").textContent = `${P.nb_coupes} / ${p.slices ? p.slices.length : "?"}`; $("r-cent").textContent = String(P.FCM_centres);
    if (R.avertissements.length) warn.innerHTML = R.avertissements.map((a) => `<p class="note">${esc(a)}</p>`).join("");
    if (P.FCM_contraste_SD !== "par coupe" && P.FCM_contraste_SD < 3 && !P.FCM_garde_fou_applique)
      warn.innerHTML += `<p class="note">La classe brillante du FCM n'est qu'à ${fmt(P.FCM_contraste_SD, 1)} SD du myocarde sain : il n'y a peut-être pas de vrai rehaussement, le FCM découpe alors du myocarde normal.</p>`;
    const maxPct = Math.max(1, ...R.methodes.map((m) => P[`LGE_pct_${m}`])), seg = R.segments.length > 0;
    $("t-meth").innerHTML = `<thead><tr><th>Méthode</th><th class="n">LGE (g)</th><th class="n">% VG</th><th style="width:30%"></th>${seg ? '<th class="n">Segments</th>' : ""}</tr></thead><tbody>` +
      R.methodes.map((m) => `<tr class="${m.startsWith("FCM") ? "hl" : ""}"><td>${nomMeth(m)}</td><td class="n">${fmt(P[`LGE_g_${m}`], 1)}</td><td class="n">${fmt(P[`LGE_pct_${m}`], 1)}</td><td><div class="bar" style="width:${(100 * P[`LGE_pct_${m}`]) / maxPct}%"></div></td>${seg ? `<td class="n">${P[`nb_segments_LGE_${m}`]}</td>` : ""}</tr>`).join("") + "</tbody>";
    $("t-coupes").innerHTML = `<thead><tr><th>Coupe</th><th>Niveau</th><th class="n">Myocarde (g)</th>${R.methodes.map((x) => `<th class="n">${nomMeth(x)} %</th>`).join("")}<th class="n">Réf. moy ± SD</th></tr></thead><tbody>` +
      R.coupes.map((l) => `<tr><td class="n" style="text-align:left">${l.coupe + 1}</td><td>${l.niveau}</td><td class="n">${fmt(l.masse_myocarde_g, 2)}</td>${R.methodes.map((x) => `<td class="n">${fmt(l[`LGE_pct_${x}`], 1)}</td>`).join("")}<td class="n">${fmt(l.remote_moyenne, 0)} ± ${fmt(l.remote_ecart_type, 0)}</td></tr>`).join("") + "</tbody>";
    $("bull").innerHTML = seg ? oeilDeBoeuf(R.segments, $("bull-meth").value) : `<p class="hint">Placez le point d'insertion antérieur du VD sur au moins une coupe pour obtenir les segments AHA.</p>`;
  }
  function oeilDeBoeuf(segments, m) {
    const val = Object.fromEntries(segments.map((l) => [l.segment, l[`LGE_pct_${m}`]]));
    const vmax = Math.max(30, ...Object.values(val));
    const C = 110, anneaux = [[70, 100, [1, 2, 3, 4, 5, 6]], [40, 70, [7, 8, 9, 10, 11, 12]], [10, 40, [13, 14, 15, 16]]];
    const pt = (r, a) => [C + r * Math.cos(a * Math.PI / 180), C - r * Math.sin(a * Math.PI / 180)];
    let svg = `<svg class="bull" viewBox="0 0 220 220" role="img" aria-label="Œil de bœuf AHA">`;
    for (const [r0, r1, segs] of anneaux) {
      const larg = 360 / segs.length;
      segs.forEach((s, k) => {
        const a0 = 90 + k * larg - larg / 2, a1 = a0 + larg, v = val[s];
        const [x0, y0] = pt(r1, a0), [x1, y1] = pt(r1, a1), [x2, y2] = pt(r0, a1), [x3, y3] = pt(r0, a0);
        const fill = v === undefined ? "var(--surface-2)" : `color-mix(in oklab, var(--lge) ${Math.round((100 * v) / vmax)}%, var(--surface))`;
        svg += `<path d="M${x0},${y0} A${r1},${r1} 0 0 0 ${x1},${y1} L${x2},${y2} A${r0},${r0} 0 0 1 ${x3},${y3} Z" style="fill:${fill}"><title>${s} ${LGE.NOMS_SEGMENTS[s]} : ${v === undefined ? "non analysé" : fmt(v, 1) + " %"}</title></path>`;
        const [tx, ty] = pt((r0 + r1) / 2, 90 + k * larg);
        svg += `<text x="${tx}" y="${ty - 4}" text-anchor="middle">${s}</text><text x="${tx}" y="${ty + 7}" text-anchor="middle">${v === undefined ? "" : fmt(v, 0) + "%"}</text>`;
      });
    }
    svg += `<circle cx="${C}" cy="${C}" r="10" style="fill:var(--surface);stroke:var(--ink);stroke-width:0.8"></circle></svg>`;
    return svg + `<p class="hint" style="text-align:center">Antérieur en haut, septum à gauche. Vérifiez la numérotation avec la superposition « Segments AHA ».</p>`;
  }

  /* ================================================================ exports */
  function exporterExcel() {
    if (!ETAT.patients.length) return;
    const anonyme = $("anonyme").checked, params = lireParams();
    const lignesP = [], lignesC = [], lignesS = [], lignesSeq = [];
    for (const p of ETAT.patients) {
      const s = p.serieUid ? p.series[p.serieUid] : null, m = p.meta;
      const ident = anonyme ? {} : { nom: m.nom, prenom: m.prenom, date_naissance: m.date_naissance, id_patient: m.id_patient, numero_accession: m.numero_accession };
      const base = {
        patient: p.id, ...ident, sexe: m.sexe, age: m.age, poids_kg: m.poids_kg, taille_m: m.taille_m,
        date_examen: m.date_examen, heure_examen: m.heure_examen, etablissement: m.etablissement, constructeur: m.constructeur, modele: m.modele, champ_T: m.champ_T,
        description_examen: m.description_examen, sequence: s ? s.description : "", protocole: s ? s.protocole : "", numero_serie: s ? s.numero : "",
        choix_sequence: s ? (p.serieManuelle ? "manuel" : "automatique") : "", TI_ms: s ? s.ti : "", TR_ms: s ? s.tr : "", TE_ms: s ? s.te : "", angle_bascule: s ? s.angle : "",
        statut: STATUTS[statutDe(p)][0], contours_corriges: p.corrige ? "oui" : "non", valide: p.valide ? "oui" : "non",
      };
      const res = p.result ? { ...p.result.patient } : {};
      delete res.patient;
      lignesP.push({ ...base, ...res });
      if (p.result) { lignesC.push(...p.result.coupes); lignesS.push(...p.result.segments); }
      for (const x of Object.values(p.series).sort((a, b) => (parseInt(a.numero) || 0) - (parseInt(b.numero) || 0)))
        lignesSeq.push({ patient: p.id, numero_serie: x.numero, description: x.description, protocole: x.protocole, nb_images: x.nbImages, nb_coupes: x.nbCoupes,
          mot_trouve: x.motTrouve || "", contours: x.nbContours, choix_auto: x.uid === p.serieAuto ? "oui" : "", retenue: x.uid === p.serieUid ? "oui" : "" });
    }
    const wb = XLSX.utils.book_new();
    const feuille = (nom, l) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(l.length ? l : [{}]), nom);
    feuille("Patients", lignesP); feuille("Coupes", lignesC); feuille("Segments_AHA", lignesS); feuille("Sequences", lignesSeq);
    feuille("Parametres", [...Object.entries(params).map(([k, v]) => ({ parametre: k, valeur: Array.isArray(v) ? v.join(", ") : v })),
      { parametre: "mots_LGE", valeur: $("p-mots").value }, { parametre: "date_export", valeur: new Date().toISOString().slice(0, 16).replace("T", " ") }]);
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    enregistrer(`resultats_LGE_${new Date().toISOString().slice(0, 10)}${anonyme ? "_anonyme" : ""}.xlsx`, new Blob([buf]));
  }
  function exporterContours() {
    const r2 = (p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];
    const contours = [...ETAT.contours].map(([uid, c]) => {
      const e = { uid };
      if (c.endo) e.endo = c.endo.map(r2); if (c.epi) e.epi = c.epi.map(r2); if (c.remote) e.remote = c.remote.map(r2);
      if (c.rv) e.insertion_vd = r2(c.rv); if (c.niveau) e.niveau = c.niveau;
      return e;
    });
    enregistrer(`contours_LGE_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ format: "contours-lge", version: 1, contours }));
  }

  /* ================================================================ lot d'exemple fictif */
  function lotExemple() {
    ETAT.patients = []; ETAT.contours.clear(); ETAT.file = [];
    let graine = 2026;
    const rnd = () => { graine |= 0; graine = (graine + 0x6D2B79F5) | 0; let t = Math.imul(graine ^ (graine >>> 15), 1 | graine); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const T = 128, SUR = 2, PX = 1.6, EP = 8, ESP = 2, C = 64;
    function contoursPile(nom, nb) {
      for (let z = 0; z < nb; z++) {
        const t = nb > 1 ? z / (nb - 1) : 0.5, rEndo = 17 - 11 * t, rEpi = rEndo + 6.5 - 1.5 * t;
        const cercle = (R) => Array.from({ length: 72 }, (_, k) => { const an = k * 5 * Math.PI / 180; return [C + R * Math.cos(an), C - R * Math.sin(an)]; });
        const sect = []; for (let k = 0; k < 12; k++) { const an = (255 + k * 30 / 11) * Math.PI / 180; sect.push([C + (rEpi - 1.5) * Math.cos(an), C - (rEpi - 1.5) * Math.sin(an)]); }
        for (let k = 11; k >= 0; k--) { const an = (255 + k * 30 / 11) * Math.PI / 180; sect.push([C + (rEndo + 1.5) * Math.cos(an), C - (rEndo + 1.5) * Math.sin(an)]); }
        ETAT.contours.set(`${nom}-${z}`, { endo: cercle(rEndo), epi: cercle(rEpi), remote: sect, rv: [C + rEpi * Math.cos(2 * Math.PI / 3), C - rEpi * Math.sin(2 * Math.PI / 3)] });
      }
    }
    function pile(nom, nb, lge, contraste) {
      const sl = [];
      for (let z = 0; z < nb; z++) {
        const t = nb > 1 ? z / (nb - 1) : 0.5, rEndo = 17 - 11 * t, rEpi = rEndo + 6.5 - 1.5 * t;
        const img = new Float64Array(T * T);
        for (let r = 0; r < T; r++) for (let c = 0; c < T; c++) {
          let s = 0;
          for (let i = 0; i < SUR; i++) for (let j = 0; j < SUR; j++) {
            const y = r + (i + 0.5) / SUR - 0.5, x = c + (j + 0.5) / SUR - 0.5, dx = x - C, dy = -(y - C), rr = Math.hypot(dx, dy);
            const ang = ((Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360;
            let v = contraste.fond;
            if (rr > rEpi && Math.hypot(dx + rEpi + 9, dy) < 11) v = contraste.vd;
            if (rr < rEndo) v = contraste.sang;
            else if (rr < rEpi) { v = contraste.myo; const prof = (rr - rEndo) / (rEpi - rEndo); if (lge && lge.z(z) && lge.dans(ang, prof)) v = 280; }
            s += v;
          }
          img[r * T + c] = Math.hypot(s / (SUR * SUR) + 12 * gauss(), 12 * gauss());
        }
        const uid = `${nom}-${z}`;
        sl.push({ image: img, rows: T, cols: T, spacing: [PX, PX], thickness: EP, position: z * (EP + ESP), uid, indice: z });
      }
      return sl;
    }
    const LGE_C = { fond: 90, vd: 210, sang: 230, myo: 55 }, CINE_C = { fond: 70, vd: 260, sang: 280, myo: 90 }, T2_C = { fond: 60, vd: 40, sang: 30, myo: 110 };
    const cas = [
      { nom: "FICTIF", prenom: "Exemple Un", ddn: "1991-03-14", sexe: "M", date: "2026-10-02", lge: { z: (z) => z >= 2 && z <= 7, dans: (a, p) => (a >= 330 || a <= 50) && p >= 0.55 }, contours: true, nomLGE: "LGE_PSIR_SA", nom4: "LGE_PSIR_4CH" },
      { nom: "FICTIF", prenom: "Exemple Deux", ddn: "1987-11-30", sexe: "F", date: "2026-10-09", lge: { z: (z) => z >= 3 && z <= 6, dans: (a, p) => a >= 160 && a <= 220 && p >= 0.3 && p <= 0.7 }, contours: true, nomLGE: "RT_PA_PSIR", nom4: "RT_4CH_PSIR" },
      { nom: "FICTIF", prenom: "Exemple Trois", ddn: "2001-06-21", sexe: "M", date: "2026-10-16", lge: null, contours: false, nomLGE: "SAX LGE TFL", nom4: "4CH LGE TFL" },
    ];
    cas.forEach((k, i) => {
      const etude = `exemple-${i}`;
      const meta = { nom: k.nom, prenom: k.prenom, date_naissance: k.ddn, sexe: k.sexe, age: "", poids_kg: "", taille_m: "", id_patient: `FICTIF-${i + 1}`, date_examen: k.date, heure_examen: "09:30",
        numero_accession: "", etablissement: "Exemple fictif", constructeur: "Exemple", modele: "IRM fictive", champ_T: 1.5, description_examen: "IRM cardiaque (exemple)" };
      const p = { etude, demo: true, series: {}, meta, statut: "attente", jeton: 0, slices: null, result: null, corrige: false, valide: false, serieManuelle: false };
      const defs = [
        ["1", "Localizer", 3, null, T2_C, 3], ["3", "CINE_bSSFP_SA", 10, null, CINE_C, 250], ["4", "CINE_bSSFP_4CH", 1, null, CINE_C, 25],
        ["6", "T2_STIR_SA", 10, null, T2_C, 10], ["7", "T1_MOLLI_SA", 3, null, T2_C, 3], ["10", "TI_scout", 1, null, LGE_C, 20],
        ["12", k.nom4, 1, k.lge, LGE_C, 1], ["13", k.nomLGE, 10, k.lge, LGE_C, 10],
      ];
      for (const [num, desc, nb, lge, contr, nbImg] of defs) {
        const uid = `${etude}-s${num}`, estLGE = desc === k.nomLGE;
        let cache = null;
        const sops = Array.from({ length: nb }, (_, z) => `${uid}-${z}`);
        p.series[uid] = { uid, numero: num, description: desc, protocole: "", ti: estLGE || desc === k.nom4 ? 300 : "", tr: "", te: "", angle: "", fichiers: [], sops,
          positions: new Set(sops), nbImages: nbImg, nbCoupes: nb,
          synth: async () => { if (!cache) cache = pile(uid, nb, lge, contr); return cache.map((s) => ({ ...s })); } };
        if (estLGE && k.contours) contoursPile(uid, nb);
      }
      ETAT.patients.push(p);
    });
    ETAT.patients.forEach((p, i) => { p.id = `P${String(i + 1).padStart(3, "0")}`; evaluerSeries(p); p.serieUid = p.serieAuto; mettreEnFile(p); });
    status("Lot d'exemple fictif : 3 examens de 8 séquences. Le premier et le deuxième ont des contours, le troisième est à contourer.");
    majListe(); traiterFile();
  }

  /* ================================================================ branchements */
  $("b-dossier").onclick = () => $("in-dossier").click();
  $("b-fichiers").onclick = () => $("in-fichiers").click();
  $("b-contours").onclick = () => $("in-contours").click();
  $("in-dossier").onchange = (e) => { ouvrir(e.target.files); e.target.value = ""; };
  $("in-fichiers").onchange = (e) => { ouvrir(e.target.files); e.target.value = ""; };
  $("in-contours").onchange = async (e) => {
    const n = await lireFichiersContours(e.target.files); e.target.value = "";
    toast(`${n} coupe(s) de contours chargée(s)`);
    for (const p of ETAT.patients) { if (!p.serieManuelle) { evaluerSeries(p); p.serieUid = p.serieAuto; } mettreEnFile(p, p === ETAT.ouvert); }
    if (ETAT.ouvert) { ETAT.ouvert.slices = null; majSelectSerie(); }
    majListe(); traiterFile();
  };
  $("b-exemple").onclick = () => { fermerFenetre(); lotExemple(); };
  $("p-mots").addEventListener("change", () => {
    store.set("lge-mots-v1", $("p-mots").value);
    for (const p of ETAT.patients) { if (p.serieManuelle) continue; const avant = p.serieUid; evaluerSeries(p); p.serieUid = p.serieAuto; if (p.serieUid !== avant) { p.slices = null; mettreEnFile(p); } }
    majListe(); traiterFile();
  });
  function recalculerTout() {
    store.set("lge-params-v1", lireParams());
    for (const p of ETAT.patients) {
      if (p === ETAT.ouvert && p.slices) { calculer(p); majLigne(p); afficherFenetre(); }
      else if (p.serieUid) mettreEnFile(p);
    }
    majResume(); traiterFile();
  }
  $("b-reset").onclick = () => { ecrireParams(LGE.PARAMETRES_DEFAUT); recalculerTout(); };
  for (const id of Object.values(champs)) $(id).addEventListener("change", recalculerTout);

  $("serie").onchange = async (e) => {
    const p = ETAT.ouvert; if (!p || !e.target.value) return;
    p.serieUid = e.target.value; p.serieManuelle = p.serieUid !== p.serieAuto; p.valide = false; p.slices = null; p.result = null; p.pile = [];
    ETAT.file = ETAT.file.filter((x) => x !== p);
    V.cur = 0; V.centre = null;
    majSelectSerie(); afficherFenetre();
    await analyserPatient(p);
    if (ETAT.ouvert !== p) return;
    V.cur = Math.floor((p.slices || []).length / 2);
    majLigne(p); majResume(); afficherFenetre();
  };
  $("b-fermer").onclick = fermerFenetre;
  fen.addEventListener("close", () => { if (ETAT.ouvert) fermerFenetre(); });
  $("b-prec").onclick = () => ouvrirPatient(ETAT.patients[ETAT.patients.indexOf(ETAT.ouvert) - 1]);
  $("b-suiv").onclick = () => ouvrirPatient(ETAT.patients[ETAT.patients.indexOf(ETAT.ouvert) + 1]);
  $("b-valider").onclick = () => { const p = ETAT.ouvert; if (!p || !p.result) return; p.valide = !p.valide; majLigne(p); majResume(); afficherFenetre(); };
  document.querySelectorAll("#tools .tool").forEach((b) => (b.onclick = () => choisirOutil(b.dataset.tool)));
  $("b-effacer").onclick = () => { const s = courante(); if (!s) return; if (V.tool === "nav") { toast("Choisissez d'abord l'outil du contour à effacer"); return; } instantane(); s[V.tool] = null; modifie(); };
  $("b-copier").onclick = () => {
    const sl = ETAT.ouvert && ETAT.ouvert.slices; if (!sl) return;
    const s = sl[V.cur], p = sl[V.cur - 1] || sl[V.cur + 1]; if (!s || !p) return;
    instantane();
    s.epi = cp(p.epi); s.endo = cp(p.endo); s.remote = cp(p.remote); s.rv = p.rv ? [...p.rv] : null;
    modifie(); toast(`Contours copiés depuis la coupe ${p.indice + 1}`);
  };
  document.querySelectorAll("#modes button").forEach((b) => (b.onclick = () => choisirMode(b.dataset.mode)));
  $("b-annuler").onclick = annuler;
  $("b-propager").onclick = propager;
  $("overlay").onchange = dessiner;
  $("zoom").onchange = () => { V.zoom = +$("zoom").value; V.centre = null; dessiner(); };
  $("contraste").oninput = () => { V.contraste = +$("contraste").value; dessiner(); };
  $("show-contours").onchange = dessiner;
  $("bull-meth").onchange = afficherResultats;
  $("b-excel").onclick = exporterExcel;
  $("b-save-contours").onclick = exporterContours;
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", dessiner);

  /* glisser-déposer d'un dossier n'importe où sur la page */
  async function fichiersDepuisDrop(dt) {
    const entrees = [...(dt.items || [])].map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
    if (!entrees.length) return [...dt.files];
    const fichiers = [];
    const lire = (ent) => new Promise((res) => {
      if (ent.isFile) ent.file((f) => { fichiers.push(f); res(); }, () => res());
      else if (ent.isDirectory) { const r = ent.createReader(), tous = []; const lot = () => r.readEntries(async (es) => { if (!es.length) { for (const x of tous) await lire(x); res(); } else { tous.push(...es); lot(); } }, () => res()); lot(); }
      else res();
    });
    for (const e of entrees) await lire(e);
    return fichiers;
  }
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", async (e) => { e.preventDefault(); if (fen.open) return; ouvrir(await fichiersDepuisDrop(e.dataTransfer)); });

  const motsSauves = store.get("lge-mots-v1", null); if (motsSauves) $("p-mots").value = motsSauves;
  const pSauves = store.get("lge-params-v1", null);
  ecrireParams(pSauves ? { ...LGE.PARAMETRES_DEFAUT, ...pSauves } : LGE.PARAMETRES_DEFAUT);
  choisirOutil("nav");
  lotExemple();
  setTimeout(downloads, 0);
})();
