#!/bin/bash
# Fabrique 3 patients synthétiques dans le dossier « patients » pour essayer l'outil.
cd "$(dirname "$0")"
./.env_lge/bin/python creer_donnees_test.py patients
echo ""; echo "Terminé. Vous pouvez fermer cette fenêtre."
