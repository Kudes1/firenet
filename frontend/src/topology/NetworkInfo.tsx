import type { NetworkDoc, SubnetDoc } from "../api/types";
import CanvasPanel from "./CanvasPanel";

type Props = {
  network: NetworkDoc;
  subnets: SubnetDoc[];
  at: { x: number; y: number };
  onClose: () => void;
};

export default function NetworkInfo({ network, subnets, at, onClose }: Props) {
  const byName = new Map(subnets.map((subnet) => [subnet.name, subnet]));
  const members = (network.subnets ?? [])
    .map((name) => byName.get(name))
    .filter((subnet): subnet is SubnetDoc => subnet !== undefined);

  return (
    <CanvasPanel title={network.name} onClose={onClose} compact testId="network-info" at={at}>
      {members.length ? (
        <ul className="network-info-list">
          {members.map((subnet) => (
            <li className="network-info-row" key={subnet.name}>
              <span>{subnet.name}</span>
              <span className="network-info-cidr">{subnet.cidr}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="network-info-empty">(нет подсетей)</p>
      )}
    </CanvasPanel>
  );
}
