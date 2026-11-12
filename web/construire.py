"""Assemble l'application en un seul fichier HTML : analyse_lge.html"""
import os
ici = os.path.dirname(os.path.abspath(__file__))
lire = lambda n: open(os.path.join(ici, "src", n), encoding="utf-8").read()
html = lire("page.html") + """
<script src="https://cdnjs.cloudflare.com/ajax/libs/dicom-parser/1.8.21/dicomParser.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
<script>
""" + lire("core.js") + "\n</script>\n<script>\n" + lire("ui.js") + "\n</script>\n"
open(os.path.join(ici, "analyse_lge.html"), "w", encoding="utf-8").write(html)
print("analyse_lge.html :", len(html) // 1024, "Ko")
# version autonome : s'ouvre par double-clic dans n'importe quel navigateur (Internet nécessaire pour les bibliothèques)
autonome = ('<!doctype html><html lang="fr"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>' + html + '</body></html>')
open(os.path.join(ici, "analyse_lge_autonome.html"), "w", encoding="utf-8").write(autonome)
# page publiée par GitHub Pages à la racine du dépôt
open(os.path.join(ici, "..", "index.html"), "w", encoding="utf-8").write(autonome)
