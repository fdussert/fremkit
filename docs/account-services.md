# Multi-service connections

A connection type can declare several named services. Each service has its own channel prefix and provider, while the account shares one set of credentials. A widget declares the service it needs in a `connection` or `connections` setting with `connectionService`; the host bridge permits subscriptions and commands only for account IDs selected in that setting. Google mail, calendar and tasks channels require explicit selection even if a downloaded manifest omits the service setting.

Credential replacement suspends the old provider generation before writes. The connection manager serializes configuration and secret updates, and refuses stale provider writes or command results after retirement. Failed multi-key writes leave the connection without an active provider until credentials are replaced or rolled back. The WebSocket host invalidates cached channel data when a provider is replaced so an old account snapshot is not replayed to a new widget.

A service channel does not silently inherit another service's permission. A widget must declare and select each account and service it uses. Existing single-service connection types retain their channel format.
