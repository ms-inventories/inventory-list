# Coolify Labels

Use these only if Coolify's normal domain field is not enough and you need to manually control wildcard/subdomain routing in labels.

These labels assume Cloudflare Tunnel points public hostnames to the Coolify proxy on `localhost:80`.

## Frontend React App

Use this on the `react-app` Coolify resource.

The frontend listens on container port `80` because this is a static Nginx site after build.

```text
traefik.enable=true
traefik.http.middlewares.gzip.compress=true
traefik.http.middlewares.redirect-to-https.redirectscheme.scheme=https
traefik.http.routers.inventory-frontend.entrypoints=http
traefik.http.routers.inventory-frontend.middlewares=gzip
traefik.http.routers.inventory-frontend.rule=(Host(`876en.org`) || Host(`admin.876en.org`) || HostRegexp(`^.+\.876en\.org$`)) && !Host(`api.876en.org`) && !Host(`auth.876en.org`) && !Host(`coolify.876en.org`) && !PathPrefix(`/api`)
traefik.http.routers.inventory-frontend.service=inventory-frontend
traefik.http.services.inventory-frontend.loadbalancer.server.port=80
caddy_0.encode=zstd gzip
caddy_0.handle_path.0_reverse_proxy={{upstreams 80}}
caddy_0.handle_path=/*
caddy_0.header=-Server
caddy_0.try_files={path} /index.html
caddy_0=http://876en.org
caddy_1.encode=zstd gzip
caddy_1.handle_path.1_reverse_proxy={{upstreams 80}}
caddy_1.handle_path=/*
caddy_1.header=-Server
caddy_1.try_files={path} /index.html
caddy_1=http://admin.876en.org
caddy_2.encode=zstd gzip
caddy_2.handle_path.2_reverse_proxy={{upstreams 80}}
caddy_2.handle_path=/*
caddy_2.header=-Server
caddy_2.try_files={path} /index.html
caddy_2=*.876en.org
caddy_ingress_network=coolify
```

## Backend API

Use this on the `backend` Coolify resource.

The backend listens on container port `3000`.

This accepts both:

- `api.876en.org`
- tenant same-origin API calls like `1st.876en.org/api`

```text
traefik.enable=true
traefik.http.middlewares.gzip.compress=true
traefik.http.middlewares.redirect-to-https.redirectscheme.scheme=https
traefik.http.routers.inventory-api.entrypoints=http
traefik.http.routers.inventory-api.middlewares=gzip
traefik.http.routers.inventory-api.rule=Host(`api.876en.org`) || (HostRegexp(`^.+\.876en\.org$`) && PathPrefix(`/api`))
traefik.http.routers.inventory-api.service=inventory-api
traefik.http.services.inventory-api.loadbalancer.server.port=3000
caddy_0.encode=zstd gzip
caddy_0.handle_path.0_reverse_proxy={{upstreams 3000}}
caddy_0.handle_path=/*
caddy_0.header=-Server
caddy_0=api.876en.org
caddy_1.encode=zstd gzip
caddy_1.reverse_proxy={{upstreams 3000}}
caddy_1.handle=/api*
caddy_1.header=-Server
caddy_1=*.876en.org
caddy_ingress_network=coolify
```

## Notes

- Put exact Cloudflare routes for `api.876en.org` and `auth.876en.org` above the wildcard route. The live Coolify control plane is separately hosted at `coolify.bensonhub.com`; `coolify.876en.org` remains excluded as a reserved alias.
- If Coolify auto-generates labels, prefer its generated labels and only add manual labels if wildcard routing fails.
- If label names collide with Coolify-generated names, change `inventory-frontend` and `inventory-api` to unique values.
