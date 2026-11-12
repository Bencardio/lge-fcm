#!/usr/bin/env python3
"""Fabrique 3 patients IRM synthétiques (DICOM + contours) dont la masse rehaussée est connue.

    python creer_donnees_test.py  [DOSSIER]      (par défaut : ./donnees_test)

  P01_lateral_sous_epicardique : LGE sous-épicardique latéral (aspect de myocardite), contours JSON
  P02_sans_LGE                 : aucun rehaussement, contours sous forme de masques
  P03_septal_intramural        : LGE intramural septal, contours au format cvi42
La vraie masse rehaussée de chaque patient est écrite dans verite_terrain.csv.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, MRImageStorage, generate_uid

TAILLE, PIXEL_MM, EPAISSEUR, ESPACE, NB_COUPES, SUR = 128, 1.6, 8.0, 2.0, 10, 4
CENTRE = (64.0, 64.0)
SIG_SANG, SIG_MYO, SIG_LGE, SIG_FOND, SIG_VD, BRUIT = 230.0, 55.0, 280.0, 90.0, 210.0, 12.0
DENSITE = 1.05


def rayons(z):
    """Rayons endo/épicardiques (pixels) : grands à la base (z=0), petits à l'apex."""
    t = z / (NB_COUPES - 1)
    r_endo = 17 - 11 * t
    return r_endo, r_endo + 6.5 - 1.5 * t


def coupe_synthetique(z, lge, rng):
    """Image (avec effet de volume partiel), fraction de LGE par pixel, polygones endo/épi."""
    n = TAILLE * SUR
    yy, xx = (np.mgrid[0:n, 0:n] + 0.5) / SUR - 0.5
    dx, dy = xx - CENTRE[0], -(yy - CENTRE[1])
    r = np.hypot(dx, dy)
    ang = np.degrees(np.arctan2(dy, dx)) % 360
    r_endo, r_epi = rayons(z)
    img = np.full((n, n), SIG_FOND)
    vd = np.hypot(dx + r_epi + 9, dy) < 11  # VD à gauche de l'image
    img[vd & (r > r_epi)] = SIG_VD
    myo = (r >= r_endo) & (r < r_epi)
    img[r < r_endo] = SIG_SANG
    img[myo] = SIG_MYO
    rehausse = np.zeros((n, n), bool)
    if lge and lge["coupes"][0] <= z <= lge["coupes"][1]:
        a0, a1 = lge["angles"]
        dans_angle = ((ang - a0) % 360) <= ((a1 - a0) % 360)
        profondeur = (r - r_endo) / (r_epi - r_endo)  # 0 = endocarde, 1 = épicarde
        p0, p1 = lge["profondeur"]
        rehausse = myo & dans_angle & (profondeur >= p0) & (profondeur <= p1)
        img[rehausse] = SIG_LGE
    bloc = lambda a: a.reshape(TAILLE, SUR, TAILLE, SUR).mean(axis=(1, 3))
    image = bloc(img)
    frac_lge = bloc(rehausse.astype(float))
    # bruit de Rice (image de magnitude)
    image = np.hypot(image + rng.normal(0, BRUIT, image.shape), rng.normal(0, BRUIT, image.shape))
    angles = np.radians(np.linspace(0, 360, 72, endpoint=False))
    cercle = lambda rr: np.column_stack([CENTRE[0] + rr * np.cos(angles), CENTRE[1] - rr * np.sin(angles)])
    return image, frac_lge, cercle(r_endo), cercle(r_epi), (r_endo, r_epi)


def ecrire_dicom(image, z, chemin, serie_uid, etude_uid, nom):
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = MRImageStorage
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = FileDataset(chemin, {}, file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID, ds.SOPInstanceUID = MRImageStorage, meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID, ds.SeriesInstanceUID = etude_uid, serie_uid
    ds.Modality, ds.PatientName, ds.PatientID = "MR", nom, nom
    ds.SeriesDescription, ds.SeriesNumber, ds.InstanceNumber = "LGE PSIR SA (synthetique)", 12, z + 1
    ds.Rows = ds.Columns = TAILLE
    ds.PixelSpacing = [PIXEL_MM, PIXEL_MM]
    ds.SliceThickness = EPAISSEUR
    ds.SpacingBetweenSlices = EPAISSEUR + ESPACE
    ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    ds.ImagePositionPatient = [0, 0, -z * (EPAISSEUR + ESPACE)]
    ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
    ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 16, 12, 11, 0
    ds.RescaleSlope, ds.RescaleIntercept = 1, 0
    ds.PixelData = np.clip(np.round(image), 0, 4095).astype(np.uint16).tobytes()
    ds.save_as(chemin, enforce_file_format=True)
    return ds.SOPInstanceUID


def xml_cvi42(contours_par_uid, chemin):
    """Écrit un fichier imitant la structure d'un export cvi42 (ImageStates > UID > Contours)."""
    res = 4
    l = ['<?xml version="1.0" encoding="UTF-8"?>',
         '<Hash:root xmlns:Hash="http://www.circlecvi.com/cvi42/Workspace/Hash/" '
         'xmlns:List="http://www.circlecvi.com/cvi42/Workspace/List/" Hash:type="map">',
         ' <Hash:item Hash:key="ImageStates" Hash:type="map">']
    for uid, contours in contours_par_uid.items():
        l.append(f'  <Hash:item Hash:key="{uid}" Hash:type="map"><Hash:item Hash:key="Contours" Hash:type="map">')
        for nom, pts in contours.items():
            l.append(f'   <Hash:item Hash:key="{nom}" Hash:type="map">')
            l.append(f'    <Hash:item Hash:key="SubpixelResolution" Hash:type="int">{res}</Hash:item>')
            l.append('    <Hash:item Hash:key="Points" Hash:type="list">')
            for x, y in pts:
                l.append(f'     <List:item Hash:type="map"><Hash:item Hash:key="x" Hash:type="int">{int(round(x * res))}</Hash:item>'
                         f'<Hash:item Hash:key="y" Hash:type="int">{int(round(y * res))}</Hash:item></List:item>')
            l.append('    </Hash:item>')
            l.append('   </Hash:item>')
        l.append('  </Hash:item></Hash:item>')
    l += [' </Hash:item>', '</Hash:root>']
    with open(chemin, "w", encoding="utf-8") as f:
        f.write("\n".join(l))


def secteur(r0, r1, a0, a1, n=12):
    """Polygone d'un secteur d'anneau (pour le myocarde sain de référence)."""
    a = np.radians(np.linspace(a0, a1, n))
    ext = np.column_stack([CENTRE[0] + r1 * np.cos(a), CENTRE[1] - r1 * np.sin(a)])
    int_ = np.column_stack([CENTRE[0] + r0 * np.cos(a[::-1]), CENTRE[1] - r0 * np.sin(a[::-1])])
    return np.vstack([ext, int_])


PATIENTS = {
    "P01_lateral_sous_epicardique": dict(format="json", lge=dict(coupes=(2, 7), angles=(330, 50), profondeur=(0.55, 1.0))),
    "P02_sans_LGE": dict(format="masques", lge=None),
    "P03_septal_intramural": dict(format="cvi42", lge=dict(coupes=(3, 6), angles=(160, 220), profondeur=(0.3, 0.7))),
}


def main():
    racine = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "donnees_test")
    rng = np.random.default_rng(2026)
    verite = []
    for nom, conf in PATIENTS.items():
        dossier = os.path.join(racine, nom)
        os.makedirs(os.path.join(dossier, "DICOM"), exist_ok=True)
        serie, etude = generate_uid(), generate_uid()
        json_coupes, masques, insertions, uids, cvi = [], [], [], [], {}
        masse_lge = masse_myo = 0.0
        vol_px_ml = PIXEL_MM ** 2 * (EPAISSEUR + ESPACE) / 1000
        for z in range(NB_COUPES):
            image, frac, endo, epi, (r_endo, r_epi) = coupe_synthetique(z, conf["lge"], rng)
            uid = ecrire_dicom(image, z, os.path.join(dossier, "DICOM", f"IM{z:04d}.dcm"), serie, etude, nom)
            # point d'insertion antérieur du VD à 120°, myocarde de référence dans la paroi inférieure
            a_vd = np.radians(120)
            vd = [CENTRE[0] + r_epi * np.cos(a_vd), CENTRE[1] - r_epi * np.sin(a_vd)]
            remote = secteur(r_endo + 1.5, r_epi - 1.5, 255, 285)
            # vérité terrain : intégrée sur le masque tiré des contours (même définition que l'outil)
            from matplotlib.path import Path
            ll, cc = np.mgrid[0:TAILLE, 0:TAILLE]
            pts = np.column_stack([cc.ravel(), ll.ravel()])
            myo = Path(epi).contains_points(pts).reshape(TAILLE, TAILLE) & ~Path(endo).contains_points(pts).reshape(TAILLE, TAILLE)
            masse_myo += myo.sum() * vol_px_ml * DENSITE
            masse_lge += frac[myo].sum() * vol_px_ml * DENSITE
            json_coupes.append({"uid": uid, "endo": endo.round(2).tolist(), "epi": epi.round(2).tolist(),
                                "remote": remote.round(2).tolist(), "insertion_vd": [round(v, 2) for v in vd]})
            lab = myo.astype(np.uint8)
            lab[Path(remote).contains_points(pts).reshape(TAILLE, TAILLE) & myo] = 2
            masques.append(lab)
            insertions.append(vd)
            uids.append(uid)
            cvi[uid] = {"saendocardialContour": endo, "saepicardialContour": epi,
                        "saReferenceMyoContour": remote, "sacardialRefPoint": np.array([vd])}
        if conf["format"] == "json":
            with open(os.path.join(dossier, "contours.json"), "w", encoding="utf-8") as f:
                json.dump({"coupes": json_coupes}, f)
        elif conf["format"] == "masques":
            np.savez_compressed(os.path.join(dossier, "masques.npz"), masques=np.array(masques),
                                insertion_vd=np.array(insertions), uids=np.array(uids))
        else:
            xml_cvi42(cvi, os.path.join(dossier, f"{nom}.cvi42wsx"))
        verite.append(f"{nom};{masse_myo:.2f};{masse_lge:.2f};{100 * masse_lge / masse_myo:.2f}")
        print(f"{nom} : VG {masse_myo:.1f} g, LGE réel {masse_lge:.1f} g ({100 * masse_lge / masse_myo:.1f} %)")
    with open(os.path.join(racine, "verite_terrain.csv"), "w", encoding="utf-8") as f:
        f.write("patient;masse_VG_g;LGE_reel_g;LGE_reel_pct\n" + "\n".join(verite) + "\n")


if __name__ == "__main__":
    main()
