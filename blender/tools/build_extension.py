"""Packages the add-on as an installable Blender extension zip, standard library only.

    python3 blender/tools/build_extension.py [output_dir]

Writes map_maker_importer-<version>.zip (default output: blender/dist). Blender's own
`blender --command extension build --source-dir blender/map_maker_importer` makes the same zip.
"""

import os
import re
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "..", "map_maker_importer")


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "dist")
    with open(os.path.join(SOURCE, "blender_manifest.toml")) as f:
        manifest = f.read()
    ext_id = re.search(r'^id\s*=\s*"([^"]+)"', manifest, re.M).group(1)
    version = re.search(r'^version\s*=\s*"([^"]+)"', manifest, re.M).group(1)
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "%s-%s.zip" % (ext_id, version))
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name in sorted(os.listdir(SOURCE)):
            if name.endswith((".py", ".toml")):
                z.write(os.path.join(SOURCE, name), name)  # manifest at the top of the zip
    print(os.path.abspath(path))


if __name__ == "__main__":
    main()
