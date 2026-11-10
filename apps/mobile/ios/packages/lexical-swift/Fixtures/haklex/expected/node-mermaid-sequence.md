```mermaid
sequenceDiagram
    participant Client
    participant Server
    participant DB
    Client->>Server: POST /api/login
    Server->>DB: Query user
    DB-->>Server: User record
    Server-->>Client: JWT token
```