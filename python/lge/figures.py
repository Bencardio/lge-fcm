"""Images de contrôle : superposition des zones rehaussées sur l'image IRM, et œil de bœuf AHA."""
from __future__ import annotations

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import ListedColormap

ROUGE = ListedColormap([[0, 0, 0, 0], [1.0, 0.15, 0.1, 0.65]])


def _cadre(coupe, marge=12):
    lignes, colonnes = np.nonzero(coupe.masque_myo)
    l0, l1 = max(lignes.min() - marge, 0), min(lignes.max() + marge + 1, coupe.image.shape[0])
    c0, c1 = max(colonnes.min() - marge, 0), min(colonnes.max() + marge + 1, coupe.image.shape[1])
    return slice(l0, l1), slice(c0, c1)


def _fenetre(image, masque):
    vals = image[masque]
    bas = np.percentile(image, 1)
    haut = max(np.percentile(vals, 99.5), np.percentile(image, 99))
    return bas, haut


def figure_patient(patient, resultats: dict, chemin: str) -> None:
    """Planche : une ligne par coupe, une colonne par méthode."""
    coupes = patient.coupes_analysees
    methodes = resultats["methodes"]
    par_coupe = {l["coupe"]: l for l in resultats["coupes"]}
    n_col = 1 + len(methodes)
    fig, axes = plt.subplots(len(coupes), n_col, figsize=(2.3 * n_col, 2.4 * len(coupes)), squeeze=False)
    for i, c in enumerate(coupes):
        sl, sc = _cadre(c)
        img = c.image[sl, sc]
        vmin, vmax = _fenetre(c.image, c.masque_myo)
        poids = c.resultats["poids"]

        ax = axes[i, 0]
        ax.imshow(img, cmap="gray", vmin=vmin, vmax=vmax)
        ax.contour(c.masque_myo[sl, sc], levels=[0.5], colors="yellow", linewidths=0.7)
        remote = c.masque_remote if c.masque_remote is not None else getattr(c, "masque_remote_auto", None)
        if remote is not None and remote.any():
            ax.contour(remote[sl, sc], levels=[0.5], colors="deepskyblue", linewidths=0.7)
        carte = c.resultats.get("carte_aha")
        if carte is not None:
            for s in np.unique(carte[carte > 0]):
                ll, cc = np.nonzero(carte[sl, sc] == s)
                if ll.size:
                    ax.text(cc.mean(), ll.mean(), str(s), color="white", fontsize=6, ha="center", va="center",
                            bbox=dict(boxstyle="round,pad=0.1", fc="black", alpha=0.5, lw=0))
        ax.set_ylabel(f"coupe {c.indice}\n{c.niveau or ''}", fontsize=8)

        for j, meth in enumerate(methodes, start=1):
            ax = axes[i, j]
            ax.imshow(img, cmap="gray", vmin=vmin, vmax=vmax)
            carte_poids = np.zeros(c.image.shape)
            carte_poids[c.masque_myo] = poids[meth]
            carte_poids = carte_poids[sl, sc]
            if meth == "FCM_pondere":
                affiche = np.ma.masked_where(~c.masque_myo[sl, sc], carte_poids)
                ax.imshow(affiche, cmap="hot", vmin=0, vmax=1, alpha=0.75)
            else:
                ax.imshow(carte_poids > 0.5, cmap=ROUGE, vmin=0, vmax=1, interpolation="nearest")
            ax.contour(c.masque_myo[sl, sc], levels=[0.5], colors="yellow", linewidths=0.4)
            pct = par_coupe[c.indice][f"LGE_pct_{meth}"]
            ax.set_xlabel(f"{pct:.1f} %", fontsize=8)
            if i == 0:
                ax.set_title(meth.replace("_", " "), fontsize=9)
        if i == 0:
            axes[i, 0].set_title("image + contours", fontsize=9)
    for ax in axes.ravel():
        ax.set_xticks([])
        ax.set_yticks([])
    tp = resultats["patient"]
    resume = "   ".join(f"{m.replace('_', ' ')} : {tp[f'LGE_g_{m}']:.1f} g ({tp[f'LGE_pct_{m}']:.1f} %)" for m in methodes)
    fig.suptitle(f"{patient.identifiant}  -  masse VG {tp['masse_VG_g']:.1f} g\n{resume}", fontsize=9)
    fig.tight_layout(rect=(0, 0, 1, 0.96))
    fig.savefig(chemin, dpi=130)
    plt.close(fig)


def oeil_de_boeuf(resultats: dict, methode: str, chemin: str) -> None:
    """Carte polaire AHA à 16 segments du % de myocarde rehaussé."""
    valeurs = {l["segment"]: l[f"LGE_pct_{methode}"] for l in resultats["segments"]}
    if not valeurs:
        return
    fig, ax = plt.subplots(figsize=(4.6, 4.6), subplot_kw={"projection": "polar"})
    cmap = plt.get_cmap("Reds")
    vmax = max(30.0, max(valeurs.values()))
    # anneaux : (rayon intérieur, extérieur), numéros des segments
    anneaux = [((2, 3), range(1, 7)), ((1, 2), range(7, 13)), ((0.25, 1), range(13, 17))]
    for (r0, r1), segments in anneaux:
        largeur = 360 / len(segments)
        for k, s in enumerate(segments):
            # segment 1 (antérieur) en haut, puis septum à gauche (vue depuis l'apex)
            centre = 90 + k * largeur
            v = valeurs.get(s)
            couleur = cmap(v / vmax) if v is not None else "lightgrey"
            ax.bar(np.radians(centre), r1 - r0, width=np.radians(largeur), bottom=r0,
                   color=couleur, edgecolor="black", linewidth=0.8)
            texte = f"{s}\n{v:.0f}%" if v is not None else str(s)
            ax.text(np.radians(centre), (r0 + r1) / 2, texte, ha="center", va="center", fontsize=7)
    ax.set_ylim(0, 3)
    ax.set_axis_off()
    ax.set_title(f"% LGE par segment AHA ({methode.replace('_', ' ')})", fontsize=9)
    fig.savefig(chemin, dpi=130, bbox_inches="tight")
    plt.close(fig)
