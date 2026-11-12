"""Structures de données communes : une coupe petit axe et un patient."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np
from matplotlib.path import Path


@dataclass
class Coupe:
    """Une coupe petit axe LGE avec ses contours."""

    image: np.ndarray                      # intensités (float), lignes x colonnes
    espacement_pixel: tuple                # (mm entre lignes, mm entre colonnes)
    epaisseur_mm: float                    # épaisseur de coupe (DICOM SliceThickness)
    position_mm: float                     # position le long de l'axe perpendiculaire aux coupes
    uid: str = ""                          # SOPInstanceUID (sert à apparier les contours cvi42)
    indice: int = 0                        # numéro de la coupe dans la série triée (0 = première)
    endo: Optional[np.ndarray] = None      # polygone endocarde, tableau (N, 2) en (x=colonne, y=ligne)
    epi: Optional[np.ndarray] = None       # polygone épicarde
    masque_myo: Optional[np.ndarray] = None    # masque booléen du myocarde (prioritaire sur endo/epi)
    masque_remote: Optional[np.ndarray] = None # masque booléen du myocarde sain de référence (n-SD)
    insertion_vd: Optional[tuple] = None   # point d'insertion antérieur du VD (x, y)
    niveau: Optional[str] = None           # "basal", "median" ou "apical" si imposé par l'utilisateur
    epaisseur_tranche_mm: float = 0.0      # épaisseur utilisée pour le calcul de masse (remplie plus tard)
    resultats: dict = field(default_factory=dict)

    @property
    def a_contours(self) -> bool:
        return self.masque_myo is not None or (self.endo is not None and self.epi is not None)

    @property
    def aire_pixel_mm2(self) -> float:
        return float(self.espacement_pixel[0] * self.espacement_pixel[1])

    def construire_masques(self) -> None:
        """Transforme les polygones en masques de pixels (centre du pixel dans le polygone)."""
        if self.masque_myo is None and self.endo is not None and self.epi is not None:
            dans_epi = polygone_vers_masque(self.epi, self.image.shape)
            dans_endo = polygone_vers_masque(self.endo, self.image.shape)
            self.masque_myo = dans_epi & ~dans_endo
        if self.masque_myo is not None and self.masque_remote is not None:
            self.masque_remote = self.masque_remote & self.masque_myo

    def centre_vg(self) -> tuple:
        """Centre du VG (x, y) : barycentre de l'endocarde, sinon du myocarde."""
        if self.endo is not None and len(self.endo) >= 3:
            return float(self.endo[:, 0].mean()), float(self.endo[:, 1].mean())
        lignes, colonnes = np.nonzero(self.masque_myo)
        return float(colonnes.mean()), float(lignes.mean())


@dataclass
class Patient:
    identifiant: str
    coupes: list
    source_contours: str = ""
    avertissements: list = field(default_factory=list)

    @property
    def coupes_analysees(self) -> list:
        return [c for c in self.coupes if c.a_contours and c.masque_myo is not None and c.masque_myo.any()]


def polygone_vers_masque(points: np.ndarray, forme: tuple) -> np.ndarray:
    """Masque booléen des pixels dont le centre est à l'intérieur du polygone (x=colonne, y=ligne)."""
    points = np.asarray(points, dtype=float)
    lignes, colonnes = np.mgrid[0:forme[0], 0:forme[1]]
    centres = np.column_stack([colonnes.ravel(), lignes.ravel()])
    return Path(points).contains_points(centres).reshape(forme)
