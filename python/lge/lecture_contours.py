"""Lecture des contours myocardiques dans plusieurs formats.

Formats reconnus dans le dossier d'un patient :
  * contours.json        format simple et documenté (voir LISEZMOI.md)
  * masques.npy / .npz   masques de pixels : 1 = myocarde, 2 = myocarde sain de référence (remote)
  * *.cvi42wsx / *.xml   espace de travail exporté de cvi42 (Circle) : contours appariés par SOPInstanceUID
  * *.mat                fichier Segment (Medviso) : images ET contours (expérimental)
"""
from __future__ import annotations

import glob
import json
import os
import xml.dom.minidom as minidom

import numpy as np

from .donnees import Coupe, polygone_vers_masque


# ---------------------------------------------------------------------------
# Détection du format
# ---------------------------------------------------------------------------

def detecter_fichier_contours(dossier: str):
    """Renvoie (format, chemin) du premier fichier de contours trouvé, ou (None, None)."""
    essais = [
        ("json", ["contours.json", "*.contours.json"]),
        ("masques", ["masques.npz", "masques.npy"]),
        ("cvi42", ["*.cvi42wsx", "*.cvi42ws", "*.xml"]),
        ("segment", ["*.mat"]),
    ]
    for fmt, motifs in essais:
        for motif in motifs:
            trouves = sorted(glob.glob(os.path.join(dossier, "**", motif), recursive=True))
            if trouves:
                return fmt, trouves[0]
    return None, None


# ---------------------------------------------------------------------------
# Appariement contours <-> coupes
# ---------------------------------------------------------------------------

def _trouver_coupe(coupes: list, entree: dict):
    uid = entree.get("uid")
    if uid:
        for c in coupes:
            if c.uid == uid:
                return c
    if "indice" in entree:
        i = int(entree["indice"])
        if 0 <= i < len(coupes):
            return coupes[i]
    return None


def appliquer_json(coupes: list, chemin: str) -> list:
    """Format simple : {"coupes": [{"uid" ou "indice", "endo", "epi", "remote", "insertion_vd", "niveau"}]}.

    Les points sont en pixels : x = colonne, y = ligne, origine au centre du pixel en haut à gauche.
    """
    with open(chemin, encoding="utf-8") as f:
        donnees = json.load(f)
    avertissements = []
    for entree in donnees.get("coupes", []):
        coupe = _trouver_coupe(coupes, entree)
        if coupe is None:
            avertissements.append(f"contour sans coupe correspondante : {entree.get('uid') or entree.get('indice')}")
            continue
        if entree.get("endo") is not None:
            coupe.endo = np.asarray(entree["endo"], float)
        if entree.get("epi") is not None:
            coupe.epi = np.asarray(entree["epi"], float)
        if entree.get("remote") is not None:
            coupe.masque_remote = polygone_vers_masque(np.asarray(entree["remote"], float), coupe.image.shape)
        if entree.get("insertion_vd") is not None:
            coupe.insertion_vd = tuple(float(v) for v in entree["insertion_vd"])
        if entree.get("niveau"):
            coupe.niveau = str(entree["niveau"]).lower()
    return avertissements


def appliquer_masques(coupes: list, chemin: str) -> list:
    """Masques de labels (nb_coupes, lignes, colonnes) : 1 = myocarde, 2 = myocarde de référence (remote)."""
    avertissements = []
    uids = None
    if chemin.endswith(".npz"):
        archive = np.load(chemin)
        labels = archive["masques"]
        insertions = archive["insertion_vd"] if "insertion_vd" in archive.files else None
        if "uids" in archive.files:
            uids = [str(u) for u in archive["uids"]]
    else:
        labels = np.load(chemin)
        insertions = None
    if uids is not None:
        # appariement sûr : chaque masque porte le SOPInstanceUID de son image
        par_uid = {c.uid: c for c in coupes}
        paires = [(i, par_uid[u]) for i, u in enumerate(uids) if u in par_uid]
        if len(paires) < len(uids):
            avertissements.append(f"{len(uids) - len(paires)} masque(s) sans image DICOM correspondante")
    else:
        # sans UID : le masque n° i correspond à la coupe n° i (coupes triées par position)
        avertissements.append("masques sans UID : appariement par ordre des coupes, vérifier les images de contrôle")
        if labels.shape[0] != len(coupes):
            avertissements.append(f"{labels.shape[0]} masques pour {len(coupes)} coupes")
        paires = list(enumerate(coupes[: labels.shape[0]]))
    for i, coupe in paires:
        lab = labels[i]
        if lab.shape != coupe.image.shape:
            avertissements.append(f"coupe {i} : taille du masque {lab.shape} différente de l'image {coupe.image.shape}, ignorée")
            continue
        if not (lab > 0).any():
            continue
        coupe.masque_myo = lab > 0
        if (lab == 2).any():
            coupe.masque_remote = lab == 2
        if insertions is not None and np.all(np.isfinite(insertions[i])):
            coupe.insertion_vd = (float(insertions[i][0]), float(insertions[i][1]))
    return avertissements


# --- cvi42 ------------------------------------------------------------------

NOMS_CVI42 = {
    "endo": ["saendocardialContour"],
    "epi": ["saepicardialContour"],
    "remote": ["saReferenceMyoContour", "saEnhancementReferenceMyoContour"],
    "insertion_vd": ["sacardialRefPoint", "sacardialInferiorRefPoint"],
}


def _cle(noeud) -> str:
    """Valeur de l'attribut 'Hash:key' (quel que soit le préfixe d'espace de noms)."""
    if noeud.nodeType != noeud.ELEMENT_NODE:
        return ""
    for nom, valeur in noeud.attributes.items():
        if nom.split(":")[-1] == "key":
            return valeur
    return ""


def _enfants(noeud):
    return [n for n in noeud.childNodes if n.nodeType == n.ELEMENT_NODE]


def _enfant(noeud, cle):
    for n in _enfants(noeud):
        if _cle(n) == cle:
            return n
    return None


def _texte(noeud) -> str:
    return "".join(t.data for t in noeud.childNodes if t.nodeType == t.TEXT_NODE).strip()


def lire_cvi42(chemin: str) -> dict:
    """Renvoie {SOPInstanceUID: {nom_contour: tableau (N, 2) en pixels}} depuis un export cvi42."""
    dom = minidom.parse(chemin)
    etats = [n for n in dom.getElementsByTagName("*") if _cle(n) == "ImageStates"]
    resultat = {}
    if not etats:
        return resultat
    for etat in _enfants(etats[0]):
        uid = _cle(etat)
        contours = _enfant(etat, "Contours")
        if contours is None:
            continue
        for contour in _enfants(contours):
            nom = _cle(contour)
            n_res = _enfant(contour, "SubpixelResolution")
            resolution = float(_texte(n_res)) if n_res is not None else 1.0
            n_points = _enfant(contour, "Points")
            if n_points is None:
                continue
            points = []
            for p in _enfants(n_points):
                nx, ny = _enfant(p, "x"), _enfant(p, "y")
                if nx is not None and ny is not None:
                    points.append((float(_texte(nx)) / resolution, float(_texte(ny)) / resolution))
            if points:
                resultat.setdefault(uid, {})[nom] = np.asarray(points, float)
    return resultat


def appliquer_cvi42(coupes: list, chemin: str) -> list:
    contours = lire_cvi42(chemin)
    avertissements = []
    if not contours:
        return [f"aucun contour lu dans {os.path.basename(chemin)} (format cvi42 non reconnu ?)"]
    par_uid = {c.uid: c for c in coupes}
    apparies = 0
    for uid, noms in contours.items():
        coupe = par_uid.get(uid)
        if coupe is None:
            continue
        apparies += 1
        for champ, alias in NOMS_CVI42.items():
            for nom in alias:
                if nom in noms:
                    pts = noms[nom]
                    if champ == "endo":
                        coupe.endo = pts
                    elif champ == "epi":
                        coupe.epi = pts
                    elif champ == "remote" and len(pts) >= 3:
                        coupe.masque_remote = polygone_vers_masque(pts, coupe.image.shape)
                    elif champ == "insertion_vd" and coupe.insertion_vd is None:
                        coupe.insertion_vd = (float(pts[0, 0]), float(pts[0, 1]))
                    break
    if apparies == 0:
        avertissements.append("aucun contour cvi42 ne correspond aux images DICOM (SOPInstanceUID différents : vérifier qu'il s'agit de la même série)")
    return avertissements


# --- Segment (Medviso) ---------------------------------------------------------

def lire_segment(chemin: str) -> tuple:
    """Lit un fichier Segment .mat : renvoie (coupes, avertissements). EXPÉRIMENTAL.

    On cherche la pile d'images de type rehaussement tardif (ou à défaut la première pile
    ayant des contours endo/épi), au premier temps du cycle.
    Dans Segment, EndoX correspond aux lignes et EndoY aux colonnes (indices Matlab, base 1).
    """
    from scipy.io import loadmat

    mat = loadmat(chemin, squeeze_me=False, struct_as_record=False)
    if "setstruct" not in mat:
        return [], ["fichier .mat sans 'setstruct' : ce n'est pas un fichier Segment"]
    piles = mat["setstruct"].ravel()
    choix = None
    for pile in piles:
        type_img = str(np.squeeze(getattr(pile, "ImageType", ""))).lower()
        if "late" in type_img or "enhancement" in type_img:
            choix = pile
            break
    if choix is None:
        for pile in piles:
            ex = getattr(pile, "EndoX", None)
            if ex is not None and np.size(ex) > 0 and np.isfinite(np.asarray(ex, float)).any():
                choix = pile
                break
    if choix is None:
        return [], ["aucune pile LGE avec contours dans le fichier Segment"]

    im = np.asarray(choix.IM, float)
    if im.ndim == 2:
        im = im[:, :, None, None]
    elif im.ndim == 3:
        im = im[:, :, None, :]
    res_x = float(np.squeeze(choix.ResolutionX))
    res_y = float(np.squeeze(choix.ResolutionY))
    epaisseur = float(np.squeeze(choix.SliceThickness))
    ecart = float(np.squeeze(getattr(choix, "SliceGap", 0) or 0))

    def tableau(nom):
        v = getattr(choix, nom, None)
        if v is None or np.size(v) == 0:
            return None
        v = np.asarray(v, float)
        if v.ndim == 2:
            v = v[:, None, :]
        return v

    endo_x, endo_y, epi_x, epi_y = (tableau(n) for n in ("EndoX", "EndoY", "EpiX", "EpiY"))
    coupes = []
    for z in range(im.shape[3]):
        coupe = Coupe(image=im[:, :, 0, z], espacement_pixel=(res_x, res_y), epaisseur_mm=epaisseur,
                      position_mm=z * (epaisseur + ecart), uid=f"segment-{z}", indice=z)
        if endo_x is not None and epi_x is not None and z < endo_x.shape[2]:
            ex, ey = endo_x[:, 0, z], endo_y[:, 0, z]
            px, py = epi_x[:, 0, z], epi_y[:, 0, z]
            if np.isfinite(ex).all() and np.isfinite(px).all():
                # Segment : X = ligne, Y = colonne, base 1 -> (x=colonne, y=ligne), base 0
                coupe.endo = np.column_stack([ey - 1, ex - 1])
                coupe.epi = np.column_stack([py - 1, px - 1])
        coupes.append(coupe)
    return coupes, ["contours Segment lus en mode expérimental : vérifier les images de contrôle"]


APPLIQUER = {"json": appliquer_json, "masques": appliquer_masques, "cvi42": appliquer_cvi42}
