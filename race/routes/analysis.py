"""Single-job analysis endpoints (``/api/refresh-single`` and
``/api/analyze-on-demand``). Re-fetches and re-classifies one job after the
dashboard's per-row refresh or auto-poll triggers it.
"""

from flask import Blueprint, current_app, jsonify, request

from race.lib import state
from race.lib.credentials import resolve_credentials, safe_err
from race.lib.jenkins_factory import make_client
from race.jenkins_client import JenkinsClientError
from race.lib.security import (
    limit,
    require_local_origin,
    upstream_jenkins_error_response,
    url_belongs_to,
    validate_jenkins_url,
)
from race.lib.timeutils import parse_promotion_time
from race.pipeline import AnalysisOrchestrator

bp = Blueprint("analysis", __name__)


def _guard():
    """Shared CSRF + SSRF guard for the single-job endpoints.
    Returns (error_response, body, is_env) — caller checks the response.
    """
    csrf = require_local_origin()
    if csrf is not None:
        return csrf, None, False
    body = request.get_json(silent=True) or {}
    is_env = body.get("api_token") == "•" * 8
    url_err = validate_jenkins_url(body.get("jenkins_url", ""), is_env_auth=is_env)
    if url_err:
        return (jsonify({"error": url_err}), 400), None, False
    return None, body, is_env


@bp.route("/api/refresh-single", methods=["POST"])
@limit("120/minute")
def refresh_single_job():
    """Re-fetch and re-analyse a single job so the dashboard can update one row in place."""
    err, body, _ = _guard()
    if err is not None:
        return err
    data = resolve_credentials(body)
    job_url = data.get("job_url")
    job_name = data.get("job_name")

    if not job_url:
        return jsonify({"error": "job_url is required"}), 400
    if not url_belongs_to(job_url, data.get("jenkins_url") or ""):
        return jsonify({"error": "job_url does not belong to the selected Jenkins instance"}), 400

    # Fall back to the existing record's name, then to the URL tail.
    if not job_name:
        existing = state.job_store_get(job_url)
        job_name = existing.job_name if existing else job_url.rstrip("/").split("/")[-1]

    try:
        promotion_time = parse_promotion_time(data)
        client = make_client(data, timeout=current_app.config["default_timeout"])
        orchestrator = AnalysisOrchestrator(
            client=client,
            classifier=current_app.classifier,  # type: ignore[attr-defined]
            max_workers=1,
            promotion_time=promotion_time,
        )
        record = orchestrator.analyze_single_job(job_url, job_name)
        state.job_store_set(job_url, record)
        return jsonify(record.to_dict(promotion_time=promotion_time)), 200
    except JenkinsClientError as e:
        # Surface upstream Jenkins 401 as 401
        current_app.logger.warning("refresh-single Jenkins error: %s", safe_err(e))
        return upstream_jenkins_error_response(e, default_status=502)
    except Exception as e:
        current_app.logger.exception("refresh-single failed")
        return jsonify({"error": safe_err(e)}), 500


@bp.route("/api/analyze-on-demand", methods=["POST"])
@limit("120/minute")
def analyze_on_demand():
    """Synchronously run Stage 1 + Stage 2 analysis for one job and return the record."""
    err, body, _ = _guard()
    if err is not None:
        return err
    data = resolve_credentials(body)
    job_url = data.get("job_url")
    job_name = data.get("job_name")

    if not job_url:
        return jsonify({"error": "job_url is required"}), 400
    if not url_belongs_to(job_url, data.get("jenkins_url") or ""):
        return jsonify({"error": "job_url does not belong to the selected Jenkins instance"}), 400

    try:
        promotion_time = parse_promotion_time(data)
        client = make_client(data, timeout=current_app.config["default_timeout"])
        orchestrator = AnalysisOrchestrator(
            client=client,
            classifier=current_app.classifier,  # type: ignore[attr-defined]
            max_workers=1,
            promotion_time=promotion_time,
        )
        record = orchestrator.analyze_single_job(job_url, job_name)
        state.job_store_set(job_url, record)
        return jsonify(record.to_dict(promotion_time=promotion_time)), 200
    except JenkinsClientError as e:
        current_app.logger.warning("analyze-on-demand Jenkins error: %s", safe_err(e))
        return upstream_jenkins_error_response(e, default_status=502)
    except Exception as e:
        current_app.logger.exception("analyze-on-demand failed")
        return jsonify({"error": safe_err(e)}), 500
