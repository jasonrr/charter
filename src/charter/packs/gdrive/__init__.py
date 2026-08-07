"""Google Drive reference pack: the client-upload (authorizeUpload) exemplar.

Large binaries never go inline (§4.5): initiate_upload returns a resumable
session URI and the client streams the bytes out-of-band. Self-registers at
import time.
"""
from charter.sdk import register
from charter.packs.gdrive import gdrive_upload

name = "gdrive"

register("gdrive.file.initiate_upload", gdrive_upload.initiate_upload,
         read=False, target_prefix="google_folder")
