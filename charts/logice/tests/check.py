# /// script
# requires-python = ">=3.11"
# dependencies = ["PyYAML==6.0.3"]
# ///
"""Check chart rendering without a cluster or real credentials."""

import subprocess
from pathlib import Path

import yaml

CHART = Path(__file__).resolve().parents[1]
API_SECURITY_CONTEXT = {
    "runAsNonRoot": True,
    "runAsUser": 65532,
    "runAsGroup": 65532,
    "readOnlyRootFilesystem": True,
    "allowPrivilegeEscalation": False,
    "capabilities": {"drop": ["ALL"]},
}
VALUES = {
    "existingSecret": "test-secret",
    "api.image.repository": "registry.example.com/api",
    "api.image.tag": "test",
    "web.image.repository": "registry.example.com/web",
    "web.image.tag": "test",
}


def helm(*args, values=None, succeeds=True):
    command = ["helm", *args]
    for key, value in (VALUES if values is None else values).items():
        command.extend(["--set-string", f"{key}={value}"])
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if succeeds:
        assert result.returncode == 0, result.stderr + result.stdout
    else:
        assert result.returncode != 0, "Expected Helm to reject invalid values"
    return result.stdout + (result.stderr if not succeeds else "")


def render(values=None, release="test"):
    output = helm("template", release, str(CHART), values=values)
    return output, [item for item in yaml.safe_load_all(output) if item]


def check_api_security_context(documents, worker_enabled=False):
    deployments = {
        item["metadata"]["labels"]["app.kubernetes.io/component"]: item
        for item in documents
        if item["kind"] == "Deployment"
    }
    api_pod = deployments["api"]["spec"]["template"]["spec"]
    containers = [api_pod["initContainers"][0], api_pod["containers"][0]]
    assert ("alerts-worker" in deployments) is worker_enabled
    if worker_enabled:
        containers.append(deployments["alerts-worker"]["spec"]["template"]["spec"]["containers"][0])
    for container in containers:
        assert container["securityContext"] == API_SECURITY_CONTEXT, container["name"]


def check_resources(documents, prefix, secret="test-secret", origin="https://logice.narumi.dev"):
    check_api_security_context(documents)
    objects = {(item["kind"], item["metadata"]["name"]): item for item in documents}
    assert len(objects) == len(documents), "Duplicate object names"
    assert not any(item["kind"] == "Secret" for item in documents)
    deployments = {
        item["metadata"]["labels"]["app.kubernetes.io/component"]: item
        for item in documents
        if item["kind"] == "Deployment"
    }
    assert set(deployments) == {"api", "web", "collector", "clickhouse", "postgres"}
    for component, deployment in deployments.items():
        pod = deployment["spec"]["template"]
        assert deployment["spec"]["replicas"] == 1
        assert pod["spec"]["automountServiceAccountToken"] is False
        assert deployment["spec"]["selector"]["matchLabels"] == pod["metadata"]["labels"]
        container = pod["spec"]["containers"][0]
        for probe in ("startupProbe", "readinessProbe", "livenessProbe"):
            if component == "postgres":
                assert container[probe]["exec"]["command"] == [
                    "pg_isready", "-h", "127.0.0.1", "-U", "logice", "-d", "logice"
                ]
            else:
                assert container[probe]["httpGet"]["port"] in {
                    port["name"] for port in container["ports"]
                }
        service_name = "logice-tunnel" if component == "web" else f"{prefix}-{component}"
        service = objects["Service", service_name]
        assert service["spec"]["type"] == ("NodePort" if component == "web" else "ClusterIP")
        if component == "web":
            assert service["spec"]["ports"][0]["nodePort"] == 30173
        else:
            assert all("nodePort" not in port for port in service["spec"]["ports"])
        assert service["spec"]["selector"] == pod["metadata"]["labels"]
        assert all(
            port["targetPort"] in {p["name"] for p in container["ports"]}
            for port in service["spec"]["ports"]
        )
        for workload in [container, *pod["spec"].get("initContainers", [])]:
            for env in workload.get("env", []):
                if "valueFrom" in env:
                    ref = env["valueFrom"]["secretKeyRef"]
                    assert ref["name"] == secret
                    assert ref["key"] in {
                        "CLICKHOUSE_PASSWORD", "OTLP_TOKEN", "ENCRYPTION_KEY", "POSTGRES_PASSWORD"
                    }
        for volume in pod["spec"].get("volumes", []):
            if "configMap" in volume:
                assert ("ConfigMap", volume["configMap"]["name"]) in objects
            if "persistentVolumeClaim" in volume:
                assert ("PersistentVolumeClaim", volume["persistentVolumeClaim"]["claimName"]) in objects

    api_env = deployments["api"]["spec"]["template"]["spec"]["containers"][0]["env"]
    assert api_env[0]["value"] == f"{prefix}-clickhouse:9000"
    api_pod = deployments["api"]["spec"]["template"]["spec"]
    api = api_pod["containers"][0]
    migration = api_pod["initContainers"][0]
    assert deployments["api"]["metadata"]["annotations"]["argocd.argoproj.io/sync-wave"] == "1"
    assert deployments["web"]["metadata"]["annotations"]["argocd.argoproj.io/sync-wave"] == "2"
    for name in ("postgres", "clickhouse", "collector"):
        assert deployments[name]["metadata"].get("annotations", {}).get("argocd.argoproj.io/sync-wave", "0") == "0"
    assert api["readinessProbe"]["httpGet"]["path"] == "/api/healthz"
    assert "timeoutSeconds" not in api["readinessProbe"]
    for probe in ("startupProbe", "livenessProbe"):
        assert api[probe]["httpGet"]["path"] == "/api/healthz"
    assert migration["name"] == "migrate"
    assert migration["args"] == ["migrate"]
    assert migration["image"] == api["image"]
    assert migration["imagePullPolicy"] == api["imagePullPolicy"]
    assert migration["env"] == api_env
    assert migration["securityContext"] == api["securityContext"]
    env = {item["name"]: item for item in api_env}
    assert env["AUTH_ORIGIN"]["value"] == origin
    assert env["COLLECTOR_URL"]["value"] == f"http://{prefix}-collector:4318"
    assert env["OTLP_TOKEN"]["valueFrom"]["secretKeyRef"]["key"] == "OTLP_TOKEN"
    policy = objects["NetworkPolicy", f"{prefix}-collector"]["spec"]
    assert policy["podSelector"]["matchLabels"] == deployments["collector"]["spec"]["template"]["metadata"]["labels"]
    assert policy["policyTypes"] == ["Ingress"]
    assert policy["ingress"][0]["ports"] == [{"protocol": "TCP", "port": 4318}]
    assert policy["ingress"][0]["from"] == [{"podSelector": {"matchLabels": deployments["api"]["spec"]["template"]["metadata"]["labels"]}}]
    assert env["ENCRYPTION_KEY"]["valueFrom"]["secretKeyRef"]["key"] == "ENCRYPTION_KEY"
    for key, value in {
        "PGHOST": f"{prefix}-postgres", "PGPORT": "5432",
        "PGUSER": "logice", "PGDATABASE": "logice",
    }.items():
        assert env[key]["value"] == value
    assert env["PGPASSWORD"]["valueFrom"]["secretKeyRef"]["key"] == "POSTGRES_PASSWORD"
    postgres_pod = deployments["postgres"]["spec"]["template"]["spec"]
    postgres = postgres_pod["containers"][0]
    compose = yaml.safe_load((CHART.parents[1] / "compose.yaml").read_text())
    assert postgres["image"] == compose["services"]["postgres"]["image"]
    pg_env = {item["name"]: item for item in postgres["env"]}
    assert pg_env["POSTGRES_USER"]["value"] == "logice"
    assert pg_env["POSTGRES_DB"]["value"] == "logice"
    assert pg_env["POSTGRES_PASSWORD"]["valueFrom"]["secretKeyRef"]["key"] == "POSTGRES_PASSWORD"
    assert postgres_pod["securityContext"] == {
        "runAsNonRoot": True,
        "runAsUser": 70,
        "runAsGroup": 70,
        "fsGroup": 70,
        "fsGroupChangePolicy": "OnRootMismatch",
    }
    assert postgres["securityContext"] == {
        "readOnlyRootFilesystem": True,
        "allowPrivilegeEscalation": False,
        "capabilities": {"drop": ["ALL"]},
    }
    assert {mount["mountPath"] for mount in postgres["volumeMounts"]} == {
        "/var/lib/postgresql", "/var/run/postgresql", "/tmp"
    }
    assert deployments["api"]["spec"]["strategy"]["type"] == "Recreate"
    assert deployments["postgres"]["spec"]["strategy"]["type"] == "Recreate"
    pg_pvc = objects["PersistentVolumeClaim", f"{prefix}-postgres"]
    assert pg_pvc["spec"]["resources"]["requests"]["storage"] == "5Gi"
    assert pg_pvc["metadata"]["annotations"]["helm.sh/resource-policy"] == "keep"
    assert pg_pvc["metadata"]["annotations"]["argocd.argoproj.io/sync-options"] == "Prune=false,Delete=false"
    assert deployments["clickhouse"]["spec"]["strategy"]["type"] == "Recreate"
    assert deployments["collector"]["spec"]["strategy"]["type"] == "Recreate"
    pvc = objects["PersistentVolumeClaim", f"{prefix}-clickhouse"]
    assert pvc["metadata"]["annotations"]["helm.sh/resource-policy"] == "keep"
    assert pvc["metadata"]["annotations"]["argocd.argoproj.io/sync-options"] == "Prune=false,Delete=false"
    assert pvc["spec"]["resources"]["requests"]["storage"] == "20Gi"

    nginx = objects["ConfigMap", f"{prefix}-web"]["data"]["default.conf"]
    assert "127.0.0.11" not in nginx
    assert f"server {prefix}-api:8080;" in nginx
    config = yaml.safe_load(objects["ConfigMap", f"{prefix}-collector"]["data"]["config.yaml"])
    assert config["exporters"]["clickhouse"]["endpoint"] == f"tcp://{prefix}-clickhouse:9000"
    reference = yaml.safe_load((CHART.parents[1] / "deploy/otel-collector.yaml").read_text())
    reference["exporters"]["clickhouse"]["endpoint"] = f"tcp://{prefix}-clickhouse:9000"
    assert config == reference, "Collector behavior must match the validated Compose configuration"
    assert config["extensions"]["bearertokenauth"]["token"] == "${env:OTLP_TOKEN}"
    for protocol in config["receivers"]["otlp"]["protocols"].values():
        assert protocol["auth"]["authenticator"] == "bearertokenauth"
    for pipeline in config["service"]["pipelines"].values():
        assert pipeline["processors"] == ["memory_limiter", "transform/project", "resource/project", "filter/project", "attributes/project"]


def main():
    compose = yaml.safe_load((CHART.parents[1] / "compose.yaml").read_text())["services"]
    assert compose["api"]["depends_on"]["migrate"]["condition"] == "service_completed_successfully"
    assert not compose["collector"].get("ports")
    assert compose["api"]["environment"]["COLLECTOR_URL"] == "http://collector:4318"
    assert compose["migrate"]["depends_on"]["postgres"]["condition"] == "service_healthy"
    assert compose["migrate"]["command"] == ["migrate"]
    assert compose["migrate"]["build"] == compose["api"]["build"]
    assert compose["migrate"]["environment"] == compose["api"]["environment"]
    assert compose["api"]["environment"]["AUTH_ORIGIN"] == "${AUTH_ORIGIN:-http://localhost:5173}"
    assert "ENCRYPTION_KEY:?" in compose["api"]["environment"]["ENCRYPTION_KEY"]
    assert compose["api"]["environment"]["PGPASSWORD"] == compose["postgres"]["environment"]["POSTGRES_PASSWORD"]
    # Match Argo CD Application creation: no values file or parameters.
    helm("lint", str(CHART), "--strict", values={})
    defaults = helm(
        "template", str(CHART), "--name-template", "logice",
        "--namespace", "logice", "--kube-version", "1.36.5",
        "--include-crds", values={},
    )
    assert defaults == render({}, release="logice")[0]
    documents = [item for item in yaml.safe_load_all(defaults) if item]
    assert len(documents) == 16
    check_resources(documents, "logice-logice", secret="logice-secrets")
    for item in documents:
        if item["kind"] == "Deployment":
            component = item["metadata"]["labels"]["app.kubernetes.io/component"]
            if component in {"api", "web"}:
                container = item["spec"]["template"]["spec"]["containers"][0]
                assert container["image"] == f"ghcr.io/narumiruna/logice-{component}:latest"
                assert container["imagePullPolicy"] == "Always"
    helm("lint", str(CHART), "--strict")
    output, documents = render()
    assert output == render()[0], "Rendering must be deterministic"
    assert len(documents) == 16
    check_resources(documents, "test-logice")
    for pvc in (item for item in documents if item["kind"] == "PersistentVolumeClaim"):
        assert "storageClassName" not in pvc["spec"]
    for key in (*VALUES, "api.authOrigin"):
        values = {**VALUES, key: ""}
        failure = helm("template", "test", str(CHART), values=values, succeeds=False)
        assert key in failure
    failure = helm(
        "template", "test", str(CHART),
        values={**VALUES, "ingress.enabled": "true"}, succeeds=False,
    )
    assert "ingress.host" in failure
    custom = {
        **VALUES,
        "ingress.enabled": "true",
        "ingress.host": "logice.internal.example.com",
        "api.authOrigin": "https://logice.internal.example.com",
        "ingress.className": "private",
        "ingress.tls[0].secretName": "logice-tls",
        "ingress.tls[0].hosts[0]": "logice.internal.example.com",
        "imagePullSecrets[0].name": "private-registry",
        "clickhouse.persistence.storageClass": "",
        "postgres.persistence.storageClass": "",
    }
    _, documents = render(custom, release="other")
    check_resources(documents, "other-logice", origin="https://logice.internal.example.com")
    ingress = next(item for item in documents if item["kind"] == "Ingress")
    assert ingress["spec"]["ingressClassName"] == "private"
    assert ingress["spec"]["tls"][0]["secretName"] == "logice-tls"
    rule = ingress["spec"]["rules"][0]
    assert rule["host"] == "logice.internal.example.com"
    assert rule["http"]["paths"][0]["backend"]["service"]["name"] == "logice-tunnel"
    for item in documents:
        if item["kind"] == "Deployment":
            assert item["spec"]["template"]["spec"]["imagePullSecrets"] == [{"name": "private-registry"}]
        if item["kind"] == "PersistentVolumeClaim":
            assert item["spec"]["storageClassName"] == ""
    _, documents = render({
        **VALUES, "clickhouse.persistence.storageClass": "fast-private",
        "postgres.persistence.storageClass": "fast-private",
    })
    for pvc in (item for item in documents if item["kind"] == "PersistentVolumeClaim"):
        assert pvc["spec"]["storageClassName"] == "fast-private"
    for origin in ("", "http://logice.narumi.dev", "https://logice.narumi.dev/path", "https://logice.narumi.dev/"):
        failure = helm("template", "test", str(CHART), values={**VALUES, "api.authOrigin": origin}, succeeds=False)
        assert "api.authOrigin" in failure
    _, local = render({**VALUES, "api.authOrigin": "http://localhost:5173"})
    check_resources(local, "test-logice", origin="http://localhost:5173")
    _, documents = render({**VALUES, "web.service.type": "ClusterIP"})
    web_service = next(item for item in documents if item["kind"] == "Service" and item["metadata"]["name"] == "logice-tunnel")
    assert web_service["spec"]["type"] == "ClusterIP"
    assert "nodePort" not in web_service["spec"]["ports"][0]
    digests = {name: "sha256:" + char * 64 for name, char in (("api", "a"), ("web", "b"))}
    pins = {**VALUES, **{f"{name}.image.digest": digest for name, digest in digests.items()}}
    _, pinned_without_worker = render({**pins, "api.image.tag": "", "web.image.tag": ""})
    check_api_security_context(pinned_without_worker)
    _, pinned = render({**pins, "api.image.tag": "", "web.image.tag": "", "alertsWorker.enabled": "true"})
    check_api_security_context(pinned, worker_enabled=True)
    for item in pinned:
        if item["kind"] == "Deployment":
            component = item["metadata"]["labels"]["app.kubernetes.io/component"]
            if component in ("api", "web", "alerts-worker"):
                image_component = "web" if component == "web" else "api"
                pod = item["spec"]["template"]["spec"]
                if component == "api":
                    assert pod["containers"][0]["readinessProbe"]["httpGet"]["path"] == "/api/readyz"
                    assert pod["containers"][0]["readinessProbe"]["timeoutSeconds"] == 3
                for container in [*pod["containers"], *pod.get("initContainers", [])]:
                    assert container["image"] == f"registry.example.com/{image_component}@{digests[image_component]}"
    for invalid in ("latest", "sha256:short", "sha256:" + "A" * 64, "sha256:" + "a" * 64 + "\\nother"):
        for component in ("api", "web"):
            failure = helm("template", "test", str(CHART), values={**VALUES, f"{component}.image.digest": invalid}, succeeds=False)
            assert f"{component}.image.digest" in failure
    _, enabled = render({**VALUES, "alertsWorker.enabled": "true"})
    check_api_security_context(enabled, worker_enabled=True)
    worker = next(item for item in enabled if item["kind"] == "Deployment" and item["metadata"]["name"] == "test-logice-alerts-worker")
    assert worker["metadata"]["annotations"]["argocd.argoproj.io/sync-wave"] == "2"
    pod = worker["spec"]["template"]["spec"]
    assert pod["automountServiceAccountToken"] is False
    container = pod["containers"][0]
    assert container["args"] == ["alerts-worker"]
    assert container["securityContext"]["readOnlyRootFilesystem"] is True
    assert "ports" not in container
    env = {item["name"]: item for item in container["env"]}
    assert "OTLP_TOKEN" not in env and "AUTH_ORIGIN" not in env and "COLLECTOR_URL" not in env
    assert env["ENCRYPTION_KEY"]["valueFrom"]["secretKeyRef"]["name"] == "test-secret"
    policy = next(item for item in enabled if item["kind"] == "NetworkPolicy" and item["metadata"]["name"] == "test-logice-alerts-worker")
    assert policy["spec"]["ingress"] == []
    assert policy["spec"]["policyTypes"] == ["Ingress", "Egress"]
    assert policy["spec"]["egress"][-1]["ports"] == [{"protocol": "TCP", "port": 443}]
    print("Helm lint and chart render checks passed")


if __name__ == "__main__":
    main()
