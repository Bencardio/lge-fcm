"""Attribution des pixels du myocarde aux segments AHA (modèle à 17 segments, segments 1 à 16).

Convention : coupes petit axe vues depuis l'apex (affichage radiologique habituel : VD à gauche
de l'image, paroi antérieure en haut). Le point d'insertion antérieur du VD sépare les segments
1 (antérieur) et 2 (antéro-septal). Si vos images sont affichées en miroir, mettre
sens_inverse = oui dans parametres.ini et vérifier les numéros sur les images de contrôle.
"""
from __future__ import annotations

import numpy as np

NOMS_SEGMENTS = {
    1: "basal antérieur", 2: "basal antéro-septal", 3: "basal inféro-septal", 4: "basal inférieur",
    5: "basal inféro-latéral", 6: "basal antéro-latéral",
    7: "médian antérieur", 8: "médian antéro-septal", 9: "médian inféro-septal", 10: "médian inférieur",
    11: "médian inféro-latéral", 12: "médian antéro-latéral",
    13: "apical antérieur", 14: "apical septal", 15: "apical inférieur", 16: "apical latéral",
}


def attribuer_niveaux(coupes: list) -> None:
    """Range chaque coupe analysée en basal / médian / apical (par tiers, de la base vers l'apex)."""
    a_classer = [c for c in coupes if c.niveau not in ("basal", "median", "apical")]
    if not a_classer:
        return
    ordonnees = sorted(coupes, key=lambda c: c.indice)
    # La base est l'extrémité dont la surface de myocarde est la plus grande.
    def surface(c):
        return c.masque_myo.sum() * c.aire_pixel_mm2
    if surface(ordonnees[0]) < surface(ordonnees[-1]):
        ordonnees = ordonnees[::-1]
    for groupe, nom in zip(np.array_split(np.arange(len(ordonnees)), 3), ("basal", "median", "apical")):
        for i in groupe:
            if ordonnees[i].niveau not in ("basal", "median", "apical"):
                ordonnees[i].niveau = nom


def _angle(coupe, x, y):
    cx, cy = coupe.centre_vg()
    return np.degrees(np.arctan2(-(np.asarray(y) - cy), np.asarray(x) - cx)) % 360


def angles_reference(coupes: list) -> dict:
    """Angle du point d'insertion du VD pour chaque coupe (repris de la coupe la plus proche si absent)."""
    connus = {c.indice: float(_angle(c, *c.insertion_vd)) for c in coupes if c.insertion_vd is not None}
    if not connus:
        return {}
    resultat = {}
    for c in coupes:
        plus_proche = min(connus, key=lambda i: abs(i - c.indice))
        resultat[c.indice] = connus[plus_proche]
    return resultat


def carte_segments(coupe, angle_vd: float, sens_inverse: bool = False) -> np.ndarray:
    """Image d'entiers : numéro de segment AHA pour chaque pixel du myocarde, 0 ailleurs."""
    lignes, colonnes = np.nonzero(coupe.masque_myo)
    theta = _angle(coupe, colonnes, lignes)
    rel = (theta - angle_vd) % 360
    if sens_inverse:
        rel = (360 - rel) % 360
    if coupe.niveau == "apical":
        # 14 septal centré sur le septum (angle_vd + 60°), secteurs de 90°
        idx = (np.floor(((rel - 15) % 360) / 90).astype(int)) % 4   # 0:14, 1:15, 2:16, 3:13
        numeros = np.array([14, 15, 16, 13])[idx]
    else:
        idx = np.floor(rel / 60).astype(int) % 6                # 0:2, 1:3, 2:4, 3:5, 4:6, 5:1
        base = 0 if coupe.niveau == "basal" else 6
        numeros = np.array([2, 3, 4, 5, 6, 1])[idx] + base
    carte = np.zeros(coupe.image.shape, dtype=int)
    carte[lignes, colonnes] = numeros
    return carte
