# Quantification du rehaussement tardif (LGE) par fuzzy c-means

Outil de recherche qui mesure le rehaussement tardif sur les coupes petit axe d'IRM cardiaque. Il compare le **fuzzy c-means** (version pondérée et défuzzifiée) aux méthodes de référence **n-SD** et **FWHM**, et donne la masse rehaussée en grammes et en % du VG, par coupe et par segment AHA.

**Utiliser l'application :** https://bencardio.github.io/lge-fcm/ (aucune installation).

Tout le calcul se fait dans le navigateur. Les images DICOM ne sont envoyées nulle part.

## Fonctions

- Ouverture d'un dossier contenant plusieurs examens : chaque examen est regroupé par ses en-têtes DICOM.
- Choix automatique de la séquence LGE : nom contenant LGE, RT ou PSIR (liste modifiable), petit axe de préférence. La séquence peut être changée patient par patient.
- Analyse en arrière-plan de tous les patients. Une fenêtre par patient permet de vérifier, corriger et valider.
- Contours importés de cvi42 (.cvi42wsx, .xml) ou d'un fichier JSON, ou tracés dans l'outil : points, cercle, main levée, retouche partielle, propagation aux autres coupes, annulation.
- Export Excel des métadonnées de l'examen (identité, dates, machine, TI, TR, TE), des résultats par patient, par coupe et par segment, et des paramètres utilisés. L'export peut être anonymisé.

## Limites actuelles

- Sans contours du myocarde, la mesure n'est pas automatique : il faut les importer ou les tracer.
- Les DICOM compressés et le format « Enhanced » multi-images ne sont pas encore lus.
- Le lecteur cvi42 a été écrit d'après la structure connue des exports et reste à valider sur de vrais fichiers.

## Organisation du dépôt

| Dossier | Contenu |
|---|---|
| `index.html` | l'application, générée (ne pas modifier à la main) |
| `web/src/core.js` | les calculs : FCM, n-SD, FWHM, masses, segments AHA |
| `web/src/ui.js`, `web/src/page.html` | l'interface |
| `web/construire.py` | assemble `index.html` : `python web/construire.py` |
| `python/` | version en ligne de commande (même méthode, résultats identiques ; voir `python/LISEZMOI.md`) |

## Méthode

- **FCM** sur les intensités du myocarde, initialisation déterministe (résultat reproductible). Réglages : nombre de classes c, coefficient de flou m, classes comptées comme rehaussées, classification par patient ou par coupe. Un garde-fou optionnel annule le LGE FCM si la classe brillante est trop proche du myocarde sain.
- **n-SD** : seuil = moyenne + n écarts-types du myocarde sain de référence (tracé, ou secteur de 60° le plus sombre).
- **FWHM** : seuil = 50 % du signal maximal (par patient ou par coupe).
- **Masse** = nombre de pixels × surface du pixel × épaisseur de tranche × 1,05 g/mL.

Aucune donnée patient ne doit être ajoutée à ce dépôt (le `.gitignore` exclut les DICOM et les exports).
