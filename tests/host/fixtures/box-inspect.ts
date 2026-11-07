import type { Inspected } from "../../../host/bin/ug-box-check.ts";

export function inspectedBox(name: string, reference: string, egress: string, broker: string): Inspected {
  return {
    configuration: {
      capAdd: [],
      image: { reference },
      initProcess: { executable: "/usr/local/bin/ug-init" },
      mounts: [
        { destination: "/tmp", options: [], source: "tmpfs", type: { tmpfs: {} } },
        {
          destination: "/home/agent",
          options: [],
          source: `/Users/owner/Library/Application Support/com.apple.container/volumes/${name}-home/volume.img`,
          type: { volume: { name: `${name}-home` } },
        },
        { destination: "/tmp/ug-egress.sock", options: [], source: egress, type: { virtiofs: {} } },
        { destination: "/tmp/ug-broker.sock", options: [], source: broker, type: { virtiofs: {} } },
      ],
      networks: [],
      publishedPorts: [],
      publishedSockets: [],
      readOnly: true,
      ssh: false,
      sysctls: {},
      virtualization: false,
    },
    status: { networks: [], state: "running" },
  };
}
