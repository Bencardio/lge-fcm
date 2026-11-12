"""Méthodes de segmentation du rehaussement tardif : fuzzy c-means, n-SD, FWHM."""
from __future__ import annotations

import numpy as np


# ---------------------------------------------------------------------------
# Fuzzy c-means
# ---------------------------------------------------------------------------

def fuzzy_c_means(valeurs: np.ndarray, c: int = 2, m: float = 2.0, max_iter: int = 500,
                  tolerance: float = 1e-6) -> dict:
    """Fuzzy c-means sur des intensités (1 dimension).

    Initialisation déterministe (centres aux percentiles régulièrement espacés) pour que le
    résultat soit strictement reproductible d'une exécution à l'autre.

    Renvoie un dictionnaire :
      centres      : centres des classes, triés du plus sombre au plus brillant
      appartenance : tableau (n_pixels, c), degré d'appartenance de chaque pixel à chaque classe
      iterations   : nombre d'itérations effectuées
      converge     : True si le critère d'arrêt a été atteint
    """
    x = np.asarray(valeurs, dtype=float).ravel()
    if c < 2:
        raise ValueError("Il faut au moins 2 classes (c >= 2).")
    if m <= 1:
        raise ValueError("Le coefficient de flou m doit être > 1.")
    etendue = float(x.max() - x.min()) or 1.0
    centres = np.percentile(x, np.linspace(100 / (2 * c), 100 - 100 / (2 * c), c))
    centres = centres + np.arange(c) * 1e-6 * etendue  # évite deux centres identiques
    exposant = 2.0 / (m - 1.0)
    converge = False
    for iteration in range(1, max_iter + 1):
        distances = np.abs(x[:, None] - centres[None, :]) + 1e-12
        # u_ij = 1 / somme_k (d_ij / d_ik)^(2/(m-1))
        inv = distances ** (-exposant)
        appartenance = inv / inv.sum(axis=1, keepdims=True)
        poids = appartenance ** m
        nouveaux = (poids * x[:, None]).sum(axis=0) / poids.sum(axis=0)
        variation = np.max(np.abs(nouveaux - centres))
        centres = nouveaux
        if variation < tolerance * etendue:
            converge = True
            break
    ordre = np.argsort(centres)
    distances = np.abs(x[:, None] - centres[None, :]) + 1e-12
    inv = distances ** (-exposant)
    appartenance = inv / inv.sum(axis=1, keepdims=True)
    return {
        "centres": centres[ordre],
        "appartenance": appartenance[:, ordre],
        "iterations": iteration,
        "converge": converge,
    }


def lge_fcm(valeurs: np.ndarray, c: int, m: float, classes_rehaussees: int = 1) -> dict:
    """Applique le FCM et renvoie, pour chaque pixel :
      ponderation : somme des appartenances aux classes « rehaussées » (les plus brillantes), entre 0 et 1
      defuzzifie  : True si la classe d'appartenance maximale est une classe rehaussée
    """
    if not 1 <= classes_rehaussees < c:
        raise ValueError("classes_rehaussees doit être compris entre 1 et c-1.")
    fcm = fuzzy_c_means(valeurs, c=c, m=m)
    u = fcm["appartenance"]
    rehaussees = list(range(c - classes_rehaussees, c))
    ponderation = u[:, rehaussees].sum(axis=1)
    defuzzifie = np.isin(np.argmax(u, axis=1), rehaussees)
    return {**fcm, "ponderation": ponderation, "defuzzifie": defuzzifie}


# ---------------------------------------------------------------------------
# n-SD et FWHM
# ---------------------------------------------------------------------------

def lge_nsd(valeurs: np.ndarray, moyenne_remote: float, ecart_type_remote: float, n: float) -> np.ndarray:
    """Pixel rehaussé si intensité > moyenne du myocarde sain + n écarts-types."""
    return np.asarray(valeurs) > moyenne_remote + n * ecart_type_remote


def lge_fwhm(valeurs: np.ndarray, maximum: float, fraction: float = 0.5) -> np.ndarray:
    """Pixel rehaussé si intensité >= fraction (50 %) du signal maximal."""
    return np.asarray(valeurs) >= fraction * maximum


def remote_automatique(coupe, nb_secteurs: int = 6) -> np.ndarray:
    """Myocarde sain de référence choisi automatiquement : le secteur angulaire de 60° le plus sombre de la coupe."""
    cx, cy = coupe.centre_vg()
    lignes, colonnes = np.nonzero(coupe.masque_myo)
    angles = np.degrees(np.arctan2(-(lignes - cy), colonnes - cx)) % 360
    secteurs = (angles // (360 / nb_secteurs)).astype(int)
    vals = coupe.image[lignes, colonnes]
    moyennes = [vals[secteurs == s].mean() if np.any(secteurs == s) else np.inf for s in range(nb_secteurs)]
    choisi = int(np.argmin(moyennes))
    masque = np.zeros_like(coupe.masque_myo)
    masque[lignes[secteurs == choisi], colonnes[secteurs == choisi]] = True
    return masque
