#!/usr/bin/env python3
"""Quantification du rehaussement tardif (LGE) par fuzzy c-means, n-SD et FWHM.

Utilisation (dans un terminal, depuis le dossier de ce fichier) :

    python analyser_lge.py  DOSSIER_DES_PATIENTS  [DOSSIER_RESULTATS]

DOSSIER_DES_PATIENTS contient un sous-dossier par patient, chacun avec ses images DICOM
et un fichier de contours (contours.json, masques.npz, export cvi42 ou fichier Segment .mat).
Les paramètres se règlent dans parametres.ini (ou avec --parametres autre_fichier.ini).
"""
from __future__ import annotations

import argparse
import configparser
import datetime
import os
import re
import sys
import traceback

import pandas as pd

ICI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ICI)

from lge import figures  # noqa: E402
from lge.analyse import analyser_patient  # noqa: E402
from lge.donnees import Patient  # noqa: E402
from lge.lecture_contours import APPLIQUER, detecter_fichier_contours, lire_segment  # noqa: E402
from lge.lecture_dicom import choisir_serie, lire_serie, trouver_series  # noqa: E402


def lire_parametres(chemin: str) -> dict:
    cfg = configparser.ConfigParser(inline_comment_prefixes=("#",))
    if not cfg.read(chemin, encoding="utf-8"):
        sys.exit(f"Fichier de paramètres introuvable : {chemin}")
    oui = lambda s: str(s).strip().lower() in ("oui", "yes", "true", "1", "vrai")
    p = {
        "fcm_c": cfg.getint("fuzzy_c_means", "nb_classes"),
        "fcm_m": cfg.getfloat("fuzzy_c_means", "coefficient_flou"),
        "fcm_classes_rehaussees": cfg.getint("fuzzy_c_means", "classes_rehaussees"),
        "fcm_echelle": cfg.get("fuzzy_c_means", "echelle").strip().lower(),
        "fcm_garde_fou_sd": cfg.getfloat("fuzzy_c_means", "garde_fou_sd", fallback=0.0),
        "nsd_n": [float(v) for v in re.split(r"[;,\s]+", cfg.get("n_sd", "n").strip()) if v],
        "nsd_remote": cfg.get("n_sd", "remote").strip().lower(),
        "fwhm_fraction": cfg.getfloat("fwhm", "fraction"),
        "fwhm_echelle": cfg.get("fwhm", "echelle").strip().lower(),
        "fwhm_percentile": cfg.getfloat("fwhm", "percentile_maximum"),
        "densite": cfg.getfloat("masse", "densite"),
        "epaisseur": cfg.get("masse", "epaisseur").strip().lower(),
        "aha_actif": oui(cfg.get("aha", "actif")),
        "aha_sens_inverse": oui(cfg.get("aha", "sens_inverse")),
        "seuil_segment_pct": cfg.getfloat("aha", "seuil_segment_pct"),
        "methode_oeil": cfg.get("aha", "methode_oeil_de_boeuf").strip(),
        "dicom_numero": cfg.get("dicom", "numero_serie", fallback="").strip(),
        "dicom_description": cfg.get("dicom", "description_serie", fallback="").strip(),
        "images_controle": oui(cfg.get("sortie", "images_controle")),
    }
    for cle in ("fcm_echelle", "fwhm_echelle"):
        if p[cle] not in ("patient", "coupe"):
            sys.exit(f"Paramètre invalide : {cle} = {p[cle]} (attendu : patient ou coupe)")
    return p


def charger_patient(dossier: str, p: dict) -> Patient:
    identifiant = os.path.basename(os.path.normpath(dossier))
    fmt, chemin = detecter_fichier_contours(dossier)
    if fmt is None:
        raise ValueError("aucun fichier de contours trouvé (contours.json, masques.npz, cvi42 ou Segment .mat)")

    if fmt == "segment":
        coupes, avert = lire_segment(chemin)
        patient = Patient(identifiant, coupes, source_contours=f"Segment ({os.path.basename(chemin)})", avertissements=avert)
    else:
        series = trouver_series(dossier)
        if not series:
            raise ValueError("aucune image DICOM trouvée")
        uid = choisir_serie(series, p["dicom_description"], p["dicom_numero"])
        coupes = lire_serie(series[uid])
        avert = APPLIQUER[fmt](coupes, chemin)
        if len(series) > 1:
            avert.append(f"{len(series)} séries DICOM trouvées, série analysée : {uid}")
        patient = Patient(identifiant, coupes, source_contours=f"{fmt} ({os.path.basename(chemin)})", avertissements=avert)

    for c in patient.coupes:
        if c.a_contours:
            c.construire_masques()
    if not patient.coupes_analysees:
        raise ValueError("les contours n'ont pu être associés à aucune image")
    return patient


def main():
    parser = argparse.ArgumentParser(description="Quantification du LGE par fuzzy c-means, n-SD et FWHM")
    parser.add_argument("patients", help="dossier contenant un sous-dossier par patient")
    parser.add_argument("resultats", nargs="?", default=None, help="dossier où écrire les résultats")
    parser.add_argument("--parametres", default=os.path.join(ICI, "parametres.ini"))
    args = parser.parse_args()

    p = lire_parametres(args.parametres)
    sortie = args.resultats or os.path.join(os.path.dirname(os.path.abspath(args.patients)), "resultats_LGE")
    os.makedirs(os.path.join(sortie, "images_controle"), exist_ok=True)

    dossiers = sorted(d for d in (os.path.join(args.patients, n) for n in os.listdir(args.patients)) if os.path.isdir(d))
    if not dossiers:
        sys.exit("Aucun sous-dossier patient trouvé.")

    toutes = {"Patients": [], "Coupes": [], "Segments_AHA": []}
    erreurs = []
    for dossier in dossiers:
        nom = os.path.basename(dossier)
        print(f"- {nom} ... ", end="", flush=True)
        try:
            patient = charger_patient(dossier, p)
            res = analyser_patient(patient, p)
            toutes["Patients"].append(res["patient"])
            toutes["Coupes"].extend(res["coupes"])
            toutes["Segments_AHA"].extend(res["segments"])
            if p["images_controle"]:
                figures.figure_patient(patient, res, os.path.join(sortie, "images_controle", f"{nom}_coupes.png"))
                if res["segments"] and p["methode_oeil"] in res["methodes"]:
                    figures.oeil_de_boeuf(res, p["methode_oeil"], os.path.join(sortie, "images_controle", f"{nom}_AHA.png"))
            tp = res["patient"]
            print(f"OK  (VG {tp['masse_VG_g']:.1f} g, LGE FCM pondéré {tp['LGE_g_FCM_pondere']:.1f} g = {tp['LGE_pct_FCM_pondere']:.1f} %)")
            for a in patient.avertissements:
                print(f"    attention : {a}")
        except Exception as e:  # on continue avec les autres patients
            print(f"ERREUR : {e}")
            erreurs.append({"patient": nom, "erreur": str(e), "detail": traceback.format_exc(limit=3)})

    horodatage = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    feuilles = {k: pd.DataFrame(v) for k, v in toutes.items()}
    feuilles["Parametres"] = pd.DataFrame(
        [{"parametre": k, "valeur": str(v)} for k, v in p.items()] + [{"parametre": "date_analyse", "valeur": horodatage}])
    if erreurs:
        feuilles["Erreurs"] = pd.DataFrame(erreurs)

    chemin_excel = os.path.join(sortie, "resultats_LGE.xlsx")
    with pd.ExcelWriter(chemin_excel) as w:
        for nom, df in feuilles.items():
            df.to_excel(w, sheet_name=nom, index=False)
    for nom in ("Patients", "Coupes", "Segments_AHA"):
        feuilles[nom].to_csv(os.path.join(sortie, f"resultats_{nom.lower()}.csv"), sep=";", decimal=",",
                             index=False, encoding="utf-8-sig")

    print(f"\n{len(toutes['Patients'])} patient(s) analysé(s), {len(erreurs)} erreur(s).")
    print(f"Résultats : {chemin_excel}")
    if p["images_controle"]:
        print(f"Images de contrôle : {os.path.join(sortie, 'images_controle')}")


if __name__ == "__main__":
    main()
