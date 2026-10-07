#!/bin/bash
sshpass -p 'h8I8odYa5fzi' scp -o StrictHostKeyChecking=no server.js root@46.8.226.36:/opt/caffe-registry/server.js
sshpass -p 'h8I8odYa5fzi' scp -o StrictHostKeyChecking=no templates/login-info.html root@46.8.226.36:/opt/caffe-registry/templates/login-info.html
sshpass -p 'h8I8odYa5fzi' ssh -o StrictHostKeyChecking=no root@46.8.226.36 "pkill -f 'node server.js' || true; sleep 1; cd /opt/caffe-registry && setsid node server.js >> /var/log/cafe-registry.log 2>&1 &"
