"""Encodes mirrored map tiles into the data URIs a standalone build embeds.

    python scripts/lib/single-file-tiles.py <job.json> <tiles.json>

job.json:
    {
      "root": "<checkout>",
      "format": "jpeg" | "webp" | "raw",
      "quality": 65,
      "tiles": [ { "key": "bakurani:grayscale:7:12:34",
                   "path": "maps/tiles/bakurani/zoom_7/12_34.webp" } ]
    }

tiles.json is a JSON object mapping every key to a data URI. Pillow is needed
for the jpeg/webp modes only; "raw" copies the source bytes unchanged.

Map imagery is photographic and only ever read as a picture of the ground, so
the black & white tiles are converted to a single luma channel: that is what
makes the embedded pyramid a fraction of the published one.
"""

import base64
import io
import json
import os
import sys


def mime_for(path, source_format):
    if source_format == 'jpeg':
        return 'image/jpeg'

    if source_format == 'webp':
        return 'image/webp'

    extension = os.path.splitext(path)[1].lower()

    return {
        '.webp': 'image/webp',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml'
    }.get(extension, 'application/octet-stream')


def encode(path, source_format, quality):
    if source_format == 'raw':
        with open(path, 'rb') as handle:
            return handle.read()

    from PIL import Image

    with Image.open(path) as image:
        buffer = io.BytesIO()

        if source_format == 'jpeg':
            image.convert('L').save(
                buffer,
                'JPEG',
                quality=quality,
                optimize=True,
                progressive=True
            )
        else:
            image.convert('RGB').save(
                buffer,
                'WEBP',
                quality=quality,
                method=6
            )

        return buffer.getvalue()


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)

    job_path, output_path = sys.argv[1], sys.argv[2]

    with open(job_path, encoding='utf-8') as handle:
        job = json.load(handle)

    root = job['root']
    source_format = job.get('format', 'jpeg')
    quality = int(job.get('quality', 65))
    tiles = job.get('tiles', [])

    result = {}
    source_bytes = 0
    encoded_bytes = 0

    for index, item in enumerate(tiles):
        source = os.path.join(root, item['path'].replace('/', os.sep))

        source_bytes += os.path.getsize(source)

        payload = encode(source, source_format, quality)
        encoded_bytes += len(payload)

        result[item['key']] = (
            f"data:{mime_for(source, source_format)};base64,"
            + base64.b64encode(payload).decode('ascii')
        )

        if index and index % 250 == 0:
            print(
                f'  encoded {index}/{len(tiles)}',
                file=sys.stderr,
                flush=True
            )

    with open(output_path, 'w', encoding='utf-8') as handle:
        json.dump(result, handle, separators=(',', ':'))

    print(
        json.dumps(
            {
                'tiles': len(tiles),
                'sourceBytes': source_bytes,
                'encodedBytes': encoded_bytes
            }
        )
    )


if __name__ == '__main__':
    main()
