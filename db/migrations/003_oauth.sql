create table gc_private.oidc_artifacts(model text not null,id text not null,payload jsonb not null,expires_at timestamptz,primary key(model,id));
create index oidc_expiry on gc_private.oidc_artifacts(expires_at);
create index oidc_grant on gc_private.oidc_artifacts((payload->>'grantId'));
create index oidc_uid on gc_private.oidc_artifacts(model,(payload->>'uid'));
