import importlib.util
import pathlib
import sys
import unittest
from unittest import mock


SCRIPTS_DIR = pathlib.Path(__file__).parents[1] / ".codex" / "skills" / "generate-story" / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))


def load_script(module_name: str, filename: str):
    spec = importlib.util.spec_from_file_location(module_name, SCRIPTS_DIR / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load {filename}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


generate_image = load_script("generate_image_security_test", "generate-image.py")
generate_video = load_script("generate_video_security_test", "generate-video.py")
story_media_common = load_script("story_media_common_security_test", "story_media_common.py")


class FakeResponse:
    def __init__(self, *, body: bytes = b"{}", headers=None):
        self.body = body
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self, size=-1):
        return self.body if size < 0 else self.body[:size]


class MediaSecurityTests(unittest.TestCase):
    def test_image_provider_polling_times_out(self):
        with (
            mock.patch.object(generate_image, "read_poll_timeout_seconds", return_value=60),
            mock.patch.object(generate_image.time, "monotonic", side_effect=[0, 61]),
            mock.patch.object(generate_image, "replicate_request") as request,
        ):
            with self.assertRaises(TimeoutError):
                generate_image.wait_for_prediction("token", "prediction")
            request.assert_not_called()

    def test_replicate_video_polling_times_out(self):
        with (
            mock.patch.object(generate_video, "read_poll_timeout_seconds", return_value=60),
            mock.patch.object(generate_video.time, "monotonic", side_effect=[0, 61]),
            mock.patch.object(generate_video, "replicate_request") as request,
        ):
            with self.assertRaises(TimeoutError):
                generate_video.wait_for_prediction("token", "prediction")
            request.assert_not_called()

    def test_openai_video_polling_times_out(self):
        with (
            mock.patch.object(generate_video, "read_poll_timeout_seconds", return_value=60),
            mock.patch.object(generate_video.time, "monotonic", side_effect=[0, 61]),
            mock.patch.object(generate_video, "request_json") as request,
        ):
            with self.assertRaises(TimeoutError):
                generate_video.wait_for_openai_video("token", "video")
            request.assert_not_called()

    def test_provider_json_response_is_bounded(self):
        oversized = b"x" * (story_media_common.MAX_JSON_RESPONSE_BYTES + 1)
        with mock.patch.object(
            story_media_common.urllib.request,
            "urlopen",
            return_value=FakeResponse(body=oversized),
        ):
            with self.assertRaisesRegex(RuntimeError, "1 MB"):
                story_media_common.request_json("GET", "https://provider.example/status")

    def test_provider_download_content_length_is_bounded(self):
        headers = {"Content-Length": str(story_media_common.MAX_DOWNLOAD_BYTES + 1)}
        with mock.patch.object(
            story_media_common.urllib.request,
            "urlopen",
            return_value=FakeResponse(headers=headers),
        ):
            with self.assertRaisesRegex(RuntimeError, "100 MB"):
                story_media_common.download_file(
                    "https://provider.example/output.mp4",
                    "story-video",
                    ".mp4",
                )


if __name__ == "__main__":
    unittest.main()
