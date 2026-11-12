"""Lecture des images LGE petit axe au format DICOM."""
from __future__ import annotations

import os
from collections import defaultdict

import numpy as np
import pydicom

from .donnees import Coupe


def _est_dicom(chemin: str) -> bool:
    try:
        with open(chemin, "rb") as f:
            f.seek(128)
            if f.read(4) == b"DICM":
                return True
        pydicom.dcmread(chemin, stop_before_pixels=True)
        return True
    except Exception:
        return False


def trouver_series(dossier: str) -> dict:
    """Regroupe tous les fichiers DICOM d'un dossier (et sous-dossiers) par série."""
    series = defaultdict(list)
    for racine, _, fichiers in os.walk(dossier):
        for nom in sorted(fichiers):
            chemin = os.path.join(racine, nom)
            if nom.startswith(".") or nom.lower().endswith((".json", ".xml", ".cvi42wsx", ".npy", ".npz", ".mat", ".png", ".txt", ".csv", ".xlsx")):
                continue
            if not _est_dicom(chemin):
                continue
            ds = pydicom.dcmread(chemin, stop_before_pixels=True)
            if "PixelSpacing" not in ds or "ImagePositionPatient" not in ds:
                continue
            cle = getattr(ds, "SeriesInstanceUID", "inconnue")
            series[cle].append(chemin)
    return dict(series)


def decrire_series(series: dict) -> list:
    """Liste lisible des séries trouvées (numéro, description, nombre d'images)."""
    lignes = []
    for uid, chemins in series.items():
        ds = pydicom.dcmread(chemins[0], stop_before_pixels=True)
        lignes.append({
            "uid": uid,
            "numero": getattr(ds, "SeriesNumber", ""),
            "description": str(getattr(ds, "SeriesDescription", "")),
            "nb_images": len(chemins),
        })
    return lignes


def choisir_serie(series: dict, filtre_description: str = "", numero: str = "") -> str:
    """Choisit la série à analyser : par numéro, par mot-clé dans la description, sinon la plus grande."""
    infos = decrire_series(series)
    if numero:
        for i in infos:
            if str(i["numero"]) == str(numero):
                return i["uid"]
    if filtre_description:
        mots = filtre_description.lower()
        candidates = [i for i in infos if mots in i["description"].lower()]
        if candidates:
            return max(candidates, key=lambda i: i["nb_images"])["uid"]
    return max(infos, key=lambda i: i["nb_images"])["uid"]


def lire_serie(chemins: list) -> list:
    """Lit une série DICOM et renvoie les coupes triées le long de l'axe perpendiculaire aux coupes."""
    coupes = []
    for chemin in chemins:
        ds = pydicom.dcmread(chemin)
        image = ds.pixel_array.astype(np.float64)
        pente = float(getattr(ds, "RescaleSlope", 1.0) or 1.0)
        ordonnee = float(getattr(ds, "RescaleIntercept", 0.0) or 0.0)
        image = image * pente + ordonnee
        orient = np.array(ds.ImageOrientationPatient, dtype=float) if "ImageOrientationPatient" in ds else np.array([1, 0, 0, 0, 1, 0], float)
        normale = np.cross(orient[:3], orient[3:])
        position = float(np.dot(np.array(ds.ImagePositionPatient, dtype=float), normale))
        espacement = tuple(float(v) for v in ds.PixelSpacing)
        epaisseur = float(getattr(ds, "SliceThickness", 0) or 0)
        coupes.append(Coupe(image=image, espacement_pixel=espacement, epaisseur_mm=epaisseur,
                            position_mm=position, uid=str(getattr(ds, "SOPInstanceUID", ""))))
    # Plusieurs images au même endroit (par ex. cine) : on garde la première.
    coupes.sort(key=lambda c: c.position_mm)
    uniques = []
    for c in coupes:
        if uniques and abs(c.position_mm - uniques[-1].position_mm) < 1e-3:
            continue
        uniques.append(c)
    for i, c in enumerate(uniques):
        c.indice = i
    return uniques
