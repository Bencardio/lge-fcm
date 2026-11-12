#!/bin/bash
# Analyse tous les patients du dossier « patients » (à côté de ce fichier) et écrit les résultats dans « resultats ».
cd "$(dirname "$0")"
./.env_lge/bin/python analyser_lge.py patients resultats
echo ""; echo "Terminé. Vous pouvez fermer cette fenêtre."
