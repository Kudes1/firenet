#!/bin/sh
set -e
iptables -N FIRENET-FWD 2>/dev/null || true
while iptables -C FORWARD -j FIRENET-FWD 2>/dev/null; do iptables -D FORWARD -j FIRENET-FWD; done
iptables -I FORWARD -j FIRENET-FWD
iptables -F FIRENET-FWD
iptables -A FIRENET-FWD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A FIRENET-FWD -m set --match-set fn_fe7eb978 src -m set --match-set fn_5d4dc5c2 dst -p tcp -m multiport --dports 443 -m comment --comment "office-to-dmz-web-https" -j ACCEPT
iptables -A FIRENET-FWD -m set --match-set fn_fe7eb978 src -m set --match-set fn_d53f648f dst -m comment --comment "office-to-dmz-db-deny" -j DROP
iptables -A FIRENET-FWD -m set --match-set fn_5d4dc5c2 src -m set --match-set fn_fe7eb978 dst -m comment --comment "dmz-to-office-deny" -j DROP
iptables -A FIRENET-FWD -m set --match-set fn_d53f648f src -m set --match-set fn_fe7eb978 dst -m comment --comment "dmz-to-office-deny" -j DROP
iptables -A FIRENET-FWD -p icmp -m comment --comment "allow-icmp" -j ACCEPT
iptables -A FIRENET-FWD -m set --match-set fn_c0235c6d src -m set --match-set fn_d53f648f dst -p tcp -m multiport --dports 22 -m comment --comment "trusted-to-db-ssh" -j ACCEPT
iptables -A FIRENET-FWD -j DROP
