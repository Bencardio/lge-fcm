# Outil de quantification du rehaussement tardif (LGE) par fuzzy c-means

Cet outil mesure la masse de myocarde rehaussé sur les coupes petit axe LGE, patient par patient, avec :

- le **fuzzy c-means (FCM)**, en version **pondérée** (chaque pixel compte pour son degré d'appartenance à la classe rehaussée, entre 0 et 1) et **défuzzifiée** (chaque pixel est rehaussé ou non) ;
- les méthodes de référence pour comparaison : **n-SD** (2, 3 et 5 SD par défaut) et **FWHM**.

Il produit un fichier Excel (et des CSV) avec les résultats par patient, par coupe et par segment AHA, ainsi que des images de contrôle.

---

## 1. Installation (une seule fois, sur Mac)

1. Placez le dossier `fcm_lge` où vous voulez (par exemple dans Documents).
2. Ouvrez l'application **Terminal** (Cmd + Espace, tapez « Terminal »).
3. Tapez `bash ` (avec un espace), glissez le fichier **installer_mac.command** dans la fenêtre du Terminal, puis appuyez sur Entrée.
4. Attendez le message « Installation terminée ».

Si Python n'est pas installé, le Mac propose d'installer les « outils de développement » : acceptez, puis recommencez l'étape 3.

## 2. Essai avec des patients synthétiques

Dans le Terminal : `bash `, glissez **creer_donnees_test_mac.command**, Entrée. Puis `bash `, glissez **analyser_mac.command**, Entrée.

Trois faux patients sont créés dans `patients/`, dont la vraie masse rehaussée est connue (`patients/verite_terrain.csv`), et les résultats apparaissent dans `resultats/`.

## 3. Analyse de vos patients

Rangez vos données ainsi, à côté des fichiers de l'outil :

```
fcm_lge/
  patients/
    Patient01/
      (les fichiers DICOM de l'examen, dans n'importe quels sous-dossiers)
      (un fichier de contours, voir plus bas)
    Patient02/
      ...
```

Lancez ensuite **analyser_mac.command** comme ci-dessus. Le nom de chaque sous-dossier sert d'identifiant du patient : utilisez des numéros anonymes.

Si un dossier contient plusieurs séries (cine, T2, LGE…), l'outil prend la plus longue. Pour choisir la bonne, indiquez son numéro ou un mot de sa description (par exemple `PSIR`) dans `parametres.ini`, rubrique `[dicom]`.

### Formats de contours acceptés

L'outil cherche dans le dossier de chaque patient, dans cet ordre :

| Fichier | D'où il vient |
|---|---|
| `contours.json` | format simple (décrit ci-dessous), utile si les contours viennent d'un autre logiciel |
| `masques.npz` | masques de pixels (1 = myocarde, 2 = myocarde sain de référence) |
| `*.cvi42wsx` ou `*.xml` | espace de travail exporté de **cvi42** : contours endo, épi, myocarde de référence et point d'insertion du VD |
| `*.mat` | fichier **Segment** (Medviso), qui contient les images et les contours. Lecture **expérimentale**, à valider sur un vrai fichier |

Les lecteurs cvi42 et Segment ont été écrits d'après la structure connue de ces fichiers, mais **pas encore testés sur un vrai export**. Envoyez-moi un patient exporté (anonymisé) pour les valider.

Format `contours.json` (coordonnées en pixels : x = colonne, y = ligne) :

```json
{"coupes": [
  {"uid": "SOPInstanceUID de l'image",
   "endo": [[x, y], ...], "epi": [[x, y], ...],
   "remote": [[x, y], ...],
   "insertion_vd": [x, y],
   "niveau": "basal"}
]}
```

`remote` (myocarde sain de référence), `insertion_vd` (point d'insertion antérieur du VD) et `niveau` sont facultatifs. On peut aussi remplacer `uid` par `"indice": 3` (numéro de coupe en partant de 0).

## 4. Réglages (`parametres.ini`)

Ouvrez `parametres.ini` avec TextEdit, modifiez la valeur après le `=`, enregistrez. Les réglages principaux :

- **nb_classes** (c) : 2 (sain / rehaussé) ou 3 (sain / zone grise / rehaussé).
- **coefficient_flou** (m) : 2 est la valeur classique. Plus m est grand, plus les appartenances sont « floues ».
- **classes_rehaussees** : avec 3 classes, 1 = seulement la plus brillante, 2 = brillante + intermédiaire.
- **echelle** du FCM : `patient` (une classification sur tout le VG, recommandé) ou `coupe`.
- **garde_fou_sd** : voir le point de vigilance ci-dessous.
- **n** pour n-SD, **fraction** pour FWHM, **densite** (1,05 g/mL), **epaisseur** de tranche.

Tous les réglages utilisés sont recopiés dans l'onglet « Parametres » du fichier Excel, ce qui sert directement pour la partie Méthodes de l'article.

## 5. Ce que vous obtenez (`resultats/`)

- **resultats_LGE.xlsx**, avec les onglets :
  - *Patients* : masse VG, masse LGE (g) et % du VG pour chaque méthode, nombre de segments atteints, centres des classes FCM, avertissements ;
  - *Coupes* : la même chose coupe par coupe, avec la moyenne et l'écart-type du myocarde sain ;
  - *Segments_AHA* : masse et % de LGE par segment (1 à 16) ;
  - *Parametres* : les réglages utilisés et la date.
- Les mêmes tableaux en **CSV** (séparateur point-virgule, virgule décimale, s'ouvrent directement dans Excel en français).
- **images_controle/** :
  - `PatientXX_coupes.png` : une ligne par coupe, une colonne par méthode. Contour du myocarde en jaune, myocarde de référence en bleu, zone rehaussée en rouge, carte d'appartenance FCM en couleur. Les numéros des segments AHA sont affichés sur la première colonne pour vérifier l'orientation ;
  - `PatientXX_AHA.png` : œil de bœuf du % de LGE par segment.

**Regardez toujours les images de contrôle** avant d'utiliser les chiffres.

## 6. Points de vigilance (utiles pour la discussion de l'article)

1. **Le FCM trouve toujours quelque chose.** Il découpe les pixels en c classes même chez un patient sans aucun rehaussement. Sur le patient synthétique sans LGE, le FCM « pur » classe environ 30 % du myocarde comme rehaussé. La colonne `FCM_contraste_SD` indique à combien d'écarts-types du myocarde sain se trouve la classe brillante : chez un vrai rehaussement elle est très élevée (> 15 sur les données de test), chez un patient sain elle est faible (environ 2). Le réglage `garde_fou_sd` (désactivé par défaut) met le LGE FCM à 0 quand ce contraste est trop faible. Si vous l'utilisez, il faudra le décrire dans les Méthodes.
2. **Volume partiel au bord endocardique.** Les pixels mêlant myocarde et sang de la cavité sont brillants et peuvent être comptés comme rehaussés, surtout en n-SD avec un seuil bas (2 SD). Des contours endocardiques tracés « serrés », sans le sang, limitent ce biais.
3. **Segments AHA.** Ils nécessitent le point d'insertion antérieur du VD. La répartition basal / médian / apical se fait par tiers des coupes, la base étant la coupe de plus grande surface myocardique. Le niveau peut être imposé dans `contours.json`.
4. **Reproductibilité.** Le FCM est initialisé de façon déterministe : le même patient donne exactement le même résultat à chaque exécution.

## 7. Résultats sur les données synthétiques (réglages par défaut)

| Patient | LGE réel | FCM pondéré | FCM défuzzifié | 2SD | 3SD | 5SD | FWHM |
|---|---|---|---|---|---|---|---|
| P01 sous-épicardique latéral | 9,0 g | 11,2 g | 9,5 g | 26,5 g | 19,1 g | 15,3 g | 9,6 g |
| P02 sans LGE | 0 g | 43,1 g (0 avec garde-fou à 3) | 39,0 g (0 avec garde-fou) | 12,3 g | 7,2 g | 3,9 g | 8,7 g |
| P03 intramural septal | 3,7 g | 6,6 g | 5,1 g | 21,5 g | 14,6 g | 9,3 g | 4,4 g |

Ces images artificielles (anneau régulier, bruit simple) servent seulement à vérifier que l'outil calcule juste. Elles ne préjugent pas des performances sur de vraies IRM.
