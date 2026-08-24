#!/bin/sh
set -e
iptables -N FIRENET-FWD 2>/dev/null || true
iptables -N UNTRUSTED 2>/dev/null || true
while iptables -C FORWARD -j FIRENET-FWD 2>/dev/null; do iptables -D FORWARD -j FIRENET-FWD; done
iptables -I FORWARD -j FIRENET-FWD
iptables -F FIRENET-FWD
iptables -A FIRENET-FWD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A FIRENET-FWD -m set --match-set fn_office-net src -m set --match-set fn_mr-1 dst -m comment --comment "UNTRUSTED" -j UNTRUSTED
iptables -A FIRENET-FWD -m set --match-set fn_main src -m set --match-set fn_mr-1 dst -p tcp -m multiport --dports 443 -m comment --comment "AI-55432" -j ACCEPT
iptables -A FIRENET-FWD -m set --match-set fn_mr-1 src -m set --match-set fn_main dst -p tcp -m multiport --sports 443 -m comment --comment "AI-55432" -j ACCEPT
iptables -A FIRENET-FWD -j RETURN
iptables -F UNTRUSTED
iptables -A UNTRUSTED -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A UNTRUSTED -m set --match-set fn_mr-1 dst -s 192.168.1.22/32 -p tcp -m multiport --dports 443 -m comment --comment "untrusted to market" -j ACCEPT
iptables -A UNTRUSTED -j DROP
