#!/bin/bash
# Installe l'outil une fois pour toutes (environ 2 minutes, nécessite Internet).
cd "$(dirname "$0")"
python3 -m venv .env_lge && ./.env_lge/bin/pip install --upgrade pip -q && ./.env_lge/bin/pip install -r requirements.txt -q \
  && echo "" && echo "Installation terminée. Vous pouvez fermer cette fenêtre." \
  || echo "ERREUR pendant l'installation : copiez ce message et envoyez-le à Claude."
