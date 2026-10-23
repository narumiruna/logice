# /// script
# requires-python = ">=3.11"
# dependencies = ["PyYAML==6.0.3"]
# ///
"""Check chart rendering without a cluster or real credentials."""

import subprocess
from pathlib import Path

import yaml

CHART = Path(__file__).resolve().parents[1]
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


def check_resources(documents, prefix):
    objects = {(item["kind"], item["metadata"]["name"]): item for item in documents}
    assert len(objects) == len(documents), "Duplicate object names"
    assert not any(item["kind"] == "Secret" for item in documents)
    deployments = {
        item["metadata"]["labels"]["app.kubernetes.io/component"]: item
        for item in documents
        if item["kind"] == "Deployment"
    }
    assert set(deployments) == {"api", "web", "collector", "clickhouse"}
    for component, deployment in deployments.items():
        pod = deployment["spec"]["template"]
        assert deployment["spec"]["replicas"] == 1
        assert pod["spec"]["automountServiceAccountToken"] is False
        assert deployment["spec"]["selector"]["matchLabels"] == pod["metadata"]["labels"]
        container = pod["spec"]["containers"][0]
        for probe in ("startupProbe", "readinessProbe", "livenessProbe"):
            assert container[probe]["httpGet"]["port"] in {
                port["name"] for port in container["ports"]
            }
        service = objects["Service", f"{prefix}-{component}"]
        assert service["spec"]["type"] == "ClusterIP"
        assert service["spec"]["selector"] == pod["metadata"]["labels"]
        assert all(
            port["targetPort"] in {p["name"] for p in container["ports"]}
            for port in service["spec"]["ports"]
        )
        for env in container.get("env", []):
            if "valueFrom" in env:
                ref = env["valueFrom"]["secretKeyRef"]
                assert ref["name"] == "test-secret"
                assert ref["key"] in {"CLICKHOUSE_PASSWORD", "OTLP_TOKEN"}
        for volume in pod["spec"].get("volumes", []):
            if "configMap" in volume:
                assert ("ConfigMap", volume["configMap"]["name"]) in objects
            if "persistentVolumeClaim" in volume:
                assert ("PersistentVolumeClaim", volume["persistentVolumeClaim"]["claimName"]) in objects

    api_env = deployments["api"]["spec"]["template"]["spec"]["containers"][0]["env"]
    assert api_env[0]["value"] == f"{prefix}-clickhouse:9000"
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
        assert pipeline["processors"] == ["memory_limiter", "resource/project", "attributes/project"]


def main():
    helm("lint", str(CHART), "--strict")
    output, documents = render()
    assert output == render()[0], "Rendering must be deterministic"
    assert len(documents) == 12
    check_resources(documents, "test-logice")
    pvc = next(item for item in documents if item["kind"] == "PersistentVolumeClaim")
    assert "storageClassName" not in pvc["spec"]
    for key in VALUES:
        values = {k: v for k, v in VALUES.items() if k != key}
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
        "ingress.className": "private",
        "ingress.tls[0].secretName": "logice-tls",
        "ingress.tls[0].hosts[0]": "logice.internal.example.com",
        "imagePullSecrets[0].name": "private-registry",
        "clickhouse.persistence.storageClass": "",
    }
    _, documents = render(custom, release="other")
    check_resources(documents, "other-logice")
    ingress = next(item for item in documents if item["kind"] == "Ingress")
    assert ingress["spec"]["ingressClassName"] == "private"
    assert ingress["spec"]["tls"][0]["secretName"] == "logice-tls"
    rule = ingress["spec"]["rules"][0]
    assert rule["host"] == "logice.internal.example.com"
    assert rule["http"]["paths"][0]["backend"]["service"]["name"] == "other-logice-web"
    for item in documents:
        if item["kind"] == "Deployment":
            assert item["spec"]["template"]["spec"]["imagePullSecrets"] == [{"name": "private-registry"}]
        if item["kind"] == "PersistentVolumeClaim":
            assert item["spec"]["storageClassName"] == ""
    _, documents = render({**VALUES, "clickhouse.persistence.storageClass": "fast-private"})
    pvc = next(item for item in documents if item["kind"] == "PersistentVolumeClaim")
    assert pvc["spec"]["storageClassName"] == "fast-private"
    print("Helm lint and chart render checks passed")


if __name__ == "__main__":
    main()
