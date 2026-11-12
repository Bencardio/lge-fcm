"""Calcul, pour un patient, de la masse rehaussée par chaque méthode (par coupe, par segment, global)."""
from __future__ import annotations

import numpy as np

from . import aha
from .methodes import lge_fcm, lge_fwhm, lge_nsd, remote_automatique


def _epaisseur_tranche(patient, mode: str) -> float:
    positions = sorted(c.position_mm for c in patient.coupes)
    epaisseur = float(np.median([c.epaisseur_mm for c in patient.coupes]))
    intervalle = float(np.median(np.diff(positions))) if len(positions) > 1 else 0.0
    if mode == "coupe":
        return epaisseur
    if mode == "intervalle":
        return intervalle or epaisseur
    # auto : intervalle entre coupes s'il est connu (inclut l'éventuel espace entre coupes), sinon épaisseur
    return intervalle if intervalle > 0 else epaisseur


def analyser_patient(patient, p: dict) -> dict:
    """Renvoie {'coupes': [...], 'segments': [...], 'patient': {...}, 'fcm': {...}} et remplit coupe.resultats."""
    coupes = patient.coupes_analysees
    if not coupes:
        raise ValueError("aucune coupe avec contours myocardiques")

    tranche = _epaisseur_tranche(patient, p["epaisseur"])
    for c in coupes:
        c.epaisseur_tranche_mm = tranche

    # --- méthodes : pour chaque coupe, un poids par pixel du myocarde (0 à 1) -------------------
    poids = {c.indice: {} for c in coupes}
    valeurs = {c.indice: c.image[c.masque_myo] for c in coupes}

    # Myocarde sain de référence (remote) : sert au n-SD et au garde-fou du FCM
    avec_remote = [c for c in coupes if c.masque_remote is not None and c.masque_remote.any()]
    groupe_remote = np.concatenate([c.image[c.masque_remote] for c in avec_remote]) if avec_remote else None
    stats_remote = {}
    for c in coupes:
        if c.masque_remote is not None and c.masque_remote.any() and p["nsd_remote"] != "auto":
            ref, source = c.image[c.masque_remote], "contour de la coupe"
        elif groupe_remote is not None and p["nsd_remote"] != "auto":
            ref, source = groupe_remote, "contours des autres coupes"
        else:
            masque = remote_automatique(c)
            c.masque_remote_auto = masque
            ref, source = c.image[masque], "automatique (secteur le plus sombre)"
        moy, et = float(ref.mean()), float(ref.std(ddof=1)) if ref.size > 1 else 0.0
        c.resultats.update({"remote_moyenne": round(moy, 2), "remote_ecart_type": round(et, 2), "remote_source": source})
        stats_remote[c.indice] = (moy, et)

    # Fuzzy c-means
    infos_fcm = {}
    if p["fcm_echelle"] == "patient":
        tout = np.concatenate([valeurs[c.indice] for c in coupes])
        r = lge_fcm(tout, p["fcm_c"], p["fcm_m"], p["fcm_classes_rehaussees"])
        moy_r = np.mean([stats_remote[c.indice][0] for c in coupes])
        et_r = np.mean([stats_remote[c.indice][1] for c in coupes])
        contraste = (r["centres"][-1] - moy_r) / et_r if et_r else float("inf")
        rejete = p["fcm_garde_fou_sd"] > 0 and contraste < p["fcm_garde_fou_sd"]
        if rejete:
            patient.avertissements.append(
                f"garde-fou FCM : classe brillante à {contraste:.1f} SD du myocarde sain (< {p['fcm_garde_fou_sd']:g}), LGE FCM mis à 0")
            r["ponderation"] = np.zeros_like(r["ponderation"])
            r["defuzzifie"] = np.zeros_like(r["defuzzifie"])
        debut = 0
        for c in coupes:
            n = valeurs[c.indice].size
            poids[c.indice]["FCM_pondere"] = r["ponderation"][debut:debut + n]
            poids[c.indice]["FCM_defuzzifie"] = r["defuzzifie"][debut:debut + n].astype(float)
            debut += n
        infos_fcm = {"centres": r["centres"].round(2).tolist(), "iterations": r["iterations"], "converge": r["converge"],
                     "contraste_sd": round(float(contraste), 2), "rejete": rejete}
    else:
        for c in coupes:
            r = lge_fcm(valeurs[c.indice], p["fcm_c"], p["fcm_m"], p["fcm_classes_rehaussees"])
            moy_r, et_r = stats_remote[c.indice]
            contraste = (r["centres"][-1] - moy_r) / et_r if et_r else float("inf")
            c.resultats["fcm_contraste_sd"] = round(float(contraste), 2)
            if p["fcm_garde_fou_sd"] > 0 and contraste < p["fcm_garde_fou_sd"]:
                r["ponderation"] = np.zeros_like(r["ponderation"])
                r["defuzzifie"] = np.zeros_like(r["defuzzifie"])
            poids[c.indice]["FCM_pondere"] = r["ponderation"]
            poids[c.indice]["FCM_defuzzifie"] = r["defuzzifie"].astype(float)
            c.resultats["fcm_centres"] = r["centres"].round(2).tolist()
        infos_fcm = {"centres": "par coupe", "iterations": "", "converge": "", "contraste_sd": "par coupe", "rejete": ""}

    # n-SD
    for c in coupes:
        moy, et = stats_remote[c.indice]
        for n in p["nsd_n"]:
            poids[c.indice][f"{_fmt(n)}SD"] = lge_nsd(valeurs[c.indice], moy, et, n).astype(float)

    # FWHM
    if p["fwhm_echelle"] == "patient":
        maxi = float(np.percentile(np.concatenate([valeurs[c.indice] for c in coupes]), p["fwhm_percentile"]))
    for c in coupes:
        m = maxi if p["fwhm_echelle"] == "patient" else float(np.percentile(valeurs[c.indice], p["fwhm_percentile"]))
        c.resultats["fwhm_maximum"] = round(m, 2)
        poids[c.indice]["FWHM"] = lge_fwhm(valeurs[c.indice], m, p["fwhm_fraction"]).astype(float)

    methodes = list(poids[coupes[0].indice].keys())

    # --- segments AHA ------------------------------------------------------------------------
    cartes = {}
    if p["aha_actif"]:
        aha.attribuer_niveaux(coupes)
        angles = aha.angles_reference(coupes)
        if angles:
            for c in coupes:
                cartes[c.indice] = aha.carte_segments(c, angles[c.indice], p["aha_sens_inverse"])
        else:
            patient.avertissements.append("pas de point d'insertion du VD : segments AHA non calculés")

    # --- masses ---------------------------------------------------------------------------------
    densite = p["densite"]
    lignes_coupes, cumul_seg = [], {}
    total_myo, total_lge = 0.0, {m: 0.0 for m in methodes}
    for c in coupes:
        vol_pixel_ml = c.aire_pixel_mm2 * c.epaisseur_tranche_mm / 1000.0
        masse_myo = c.masque_myo.sum() * vol_pixel_ml * densite
        total_myo += masse_myo
        ligne = {"patient": patient.identifiant, "coupe": c.indice, "niveau": c.niveau or "",
                 "position_mm": round(c.position_mm, 2), "masse_myocarde_g": round(masse_myo, 3)}
        c.resultats["poids"] = poids[c.indice]
        for meth in methodes:
            g = float(poids[c.indice][meth].sum()) * vol_pixel_ml * densite
            total_lge[meth] += g
            ligne[f"LGE_g_{meth}"] = round(g, 3)
            ligne[f"LGE_pct_{meth}"] = round(100 * g / masse_myo, 2) if masse_myo else 0.0
        for cle in ("remote_moyenne", "remote_ecart_type", "remote_source", "fwhm_maximum", "fcm_contraste_sd"):
            ligne[cle] = c.resultats.get(cle)
        lignes_coupes.append(ligne)

        if c.indice in cartes:
            carte_myo = cartes[c.indice][c.masque_myo]
            for s in np.unique(carte_myo):
                sel = carte_myo == s
                d = cumul_seg.setdefault(int(s), {"myo": 0.0, **{m: 0.0 for m in methodes}})
                d["myo"] += sel.sum() * vol_pixel_ml * densite
                for meth in methodes:
                    d[meth] += float(poids[c.indice][meth][sel].sum()) * vol_pixel_ml * densite
    for c in coupes:
        c.resultats["carte_aha"] = cartes.get(c.indice)

    lignes_segments = []
    for s in sorted(cumul_seg):
        d = cumul_seg[s]
        ligne = {"patient": patient.identifiant, "segment": s, "nom": aha.NOMS_SEGMENTS[s],
                 "masse_myocarde_g": round(d["myo"], 3)}
        for meth in methodes:
            ligne[f"LGE_g_{meth}"] = round(d[meth], 3)
            ligne[f"LGE_pct_{meth}"] = round(100 * d[meth] / d["myo"], 2) if d["myo"] else 0.0
        lignes_segments.append(ligne)

    ligne_patient = {"patient": patient.identifiant, "nb_coupes": len(coupes),
                     "epaisseur_tranche_mm": round(tranche, 2), "masse_VG_g": round(total_myo, 2)}
    for meth in methodes:
        ligne_patient[f"LGE_g_{meth}"] = round(total_lge[meth], 2)
        ligne_patient[f"LGE_pct_{meth}"] = round(100 * total_lge[meth] / total_myo, 2) if total_myo else 0.0
    if lignes_segments:
        seuil = p["seuil_segment_pct"]
        for meth in methodes:
            ligne_patient[f"nb_segments_LGE_{meth}"] = sum(1 for l in lignes_segments if l[f"LGE_pct_{meth}"] > seuil)
    ligne_patient["FCM_centres"] = str(infos_fcm["centres"])
    ligne_patient["FCM_iterations"] = infos_fcm["iterations"]
    ligne_patient["FCM_converge"] = infos_fcm["converge"]
    ligne_patient["FCM_contraste_SD"] = infos_fcm["contraste_sd"]
    ligne_patient["FCM_garde_fou_applique"] = infos_fcm["rejete"]
    ligne_patient["source_contours"] = patient.source_contours
    ligne_patient["avertissements"] = " | ".join(patient.avertissements)

    return {"coupes": lignes_coupes, "segments": lignes_segments, "patient": ligne_patient, "methodes": methodes}


def _fmt(n: float) -> str:
    return str(int(n)) if float(n).is_integer() else str(n)
