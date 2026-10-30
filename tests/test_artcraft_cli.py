"""Behavior checks for public catalog parsing and the headless CLI."""

import contextlib
import importlib.util
import io
import json
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE_PATH = Path(__file__).parents[1] / "artcraft_cli.py"
SPEC = importlib.util.spec_from_file_location("artcraft_cli", MODULE_PATH)
cli = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cli)


class CatalogTests(unittest.TestCase):
    def test_future_fields_and_model_ids_are_preserved(self):
        data = {"success": True, "models": [{"model": "future_model", "new_option": 7}]}
        parsed = cli.parse_catalog(json.dumps(data).encode())
        self.assertEqual(parsed["models"], data["models"])
        self.assertEqual(parsed["providers"], [])

    def test_rejects_error_responses_and_malformed_models(self):
        for data in ({}, {"success": False}, {"success": True, "models": ["broken"]}):
            with self.subTest(data=data), self.assertRaises(cli.CliError):
                cli.parse_catalog(json.dumps(data).encode())

    def test_rejects_html_response(self):
        with self.assertRaisesRegex(cli.CliError, "valid JSON"):
            cli.parse_catalog(b"<html>not a catalog</html>")

    def test_provider_overrides_remain_inspectable(self):
        catalog = {"providers": [{"provider": "fal", "models": [
            {"model": "example", "overrides": {"is_disabled": True}}
        ]}]}
        self.assertEqual(cli.providers_for_model(catalog, "example"), [
            {"provider": "fal", "model": "example", "overrides": {"is_disabled": True}}
        ])

    def test_missing_disabled_flag_is_not_reported_as_enabled(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            cli.print_models({"models": [{"model": "example"}], "kind": "image",
                              "provider_filter": "all", "source": "test"})
        self.assertIn("not flagged", output.getvalue())

    def test_offline_doctor_never_calls_network(self):
        with patch.object(cli, "fetch_catalog") as fetch, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(["doctor", "--offline"]), 0)
        fetch.assert_not_called()

    def test_unknown_model_is_a_clean_error(self):
        stderr = io.StringIO()
        with patch.object(cli, "fetch_catalog", return_value={"models": []}), contextlib.redirect_stderr(stderr):
            self.assertEqual(cli.main(["model", "missing"]), 1)
        self.assertIn("Unknown image model", stderr.getvalue())

    def test_requests_are_get_without_credentials(self):
        response = unittest.mock.MagicMock()
        response.__enter__.return_value.read.return_value = b'{"success":true,"models":[]}'
        with patch.object(cli, "urlopen", return_value=response) as open_url:
            cli.fetch_catalog("image", "all", 5)
        request = open_url.call_args.args[0]
        self.assertEqual(request.get_method(), "GET")
        self.assertIsNone(request.data)
        self.assertFalse(any(k.lower() in ("cookie", "authorization") for k in request.headers))
        self.assertTrue(request.full_url.endswith("/v1/omni_gen/models/image?provider=all"))


if __name__ == "__main__":
    unittest.main()
