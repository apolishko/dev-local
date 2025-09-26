# AMS (Freya) - Cloud Deployment Guide

This document outlines the environment configuration and cloud service requirements for deploying AMS to
staging/production environments. AMS uses PostgreSQL 17 as its primary database with Knex.js for query building and
migrations.

## Required Cloud Services

- **PostgreSQL 17** - Primary relational database for assets and asset schemas
- **RabbitMQ** - **SHARED** message queue for async processing - **MUST** be the same RabbitMQ instance used by the
  Generator service for inter-service communication
- **Azure Blob Storage** - File storage with SAS URL generation

## Environment Variables

| Variable                              | Required | Default       | Description                                             | Example Value                                    |
|---------------------------------------|----------|---------------|---------------------------------------------------------|--------------------------------------------------|
| **Application Configuration**         |          |               |                                                         |                                                  |
| `NODE_ENV`                            | No       | `development` | Node environment (must be `production` for prod)        | `production`                                     |
| `LOG_LEVEL`                           | No       | `INFO`        | Log level (ERROR, WARN, INFO, DEBUG)                    | `INFO`                                           |
| `LOG_COLORED`                         | No       | `false`       | Enable colored log output                               | `false`                                          |
| `PORT`                                | No       | `3000`        | Application port                                        | `3000`                                           |
| `HOST`                                | No       | `0.0.0.0`     | Application host                                        | `0.0.0.0`                                        |
| `EXT_BASE_URL`                        | **Yes**  | -             | External URL where the service is accessible            | `https://ams.indg.com`                           |
| `GENERATE_API_DOCS`                   | No       | `false`       | Generate OpenAPI documentation                          | `false`                                          |
| **Database Configuration**            |          |               |                                                         |                                                  |
| `DB_HOST`                             | **Yes**  | `localhost`   | PostgreSQL host                                         | `postgres.azure.com`                             |
| `DB_PORT`                             | **Yes**  | `5432`        | PostgreSQL port                                         | `5432`                                           |
| `DB_USER`                             | **Yes**  | -             | Database username                                       | `ams_user`                                       |
| `DB_PASS`                             | **Yes**  | -             | Database password                                       | `secure_password`                                |
| `DB_NAME`                             | **Yes**  | -             | Database name                                           | `ams_production`                                 |
| `DB_MIN_POOL_SIZE`                    | No       | `5`           | Minimum connection pool size                            | `5`                                              |
| `DB_MAX_POOL_SIZE`                    | No       | `20`          | Maximum connection pool size                            | `20`                                             |
| `DB_CHECK`                            | No       | `true`        | Verify database connection on startup                   | `true`                                           |
| `DB_RUN_MIGRATIONS`                   | No       | `false`       | Run database migrations on startup                      | `true`                                           |
| `DB_DEBUG_QUERIES`                    | No       | `false`       | Enable query debugging (development only)               | `false`                                          |
| `DB_SSL`                              | No       | `false`       | Enable SSL for database connection (required for Azure) | `true`                                           |
| `DB_SSL_REJECT_UNAUTHORIZED`          | No       | `true`        | Reject unauthorized SSL certificates                    | `false`                                          |
| **RabbitMQ Configuration**            |          |               |                                                         |                                                  |
| `RABBITMQ_URL`                        | **Yes**  | -             | RabbitMQ connection string                              | `amqp://user:pass@rabbitmq.cloud.com:5672`       |
| `RABBITMQ_QUEUE`                      | **Yes**  | -             | RabbitMQ queue name for AMS                             | `ams`                                            |
| **Azure Storage Configuration**       |          |               |                                                         |                                                  |
| `AZURE_STORAGE_CONNECTION_STRING`     | **Yes**  | -             | Azure Storage account connection                        | `DefaultEndpointsProtocol=https;AccountName=...` |
| `AZURE_STORAGE_CONTAINER_NAME`        | **Yes**  | -             | Azure blob container for files                          | `ams-files-prod`                                 |
| `AZURE_STORAGE_WRITE_SAS_EXPIRE_TIME` | **Yes**  | -             | SAS URL expiration time for uploads (short-lived)       | `15m`                                            |
| `AZURE_STORAGE_READ_SAS_EXPIRE_TIME`  | **Yes**  | -             | SAS URL expiration time for downloads (long-lived)      | `365d`                                           |
| `AZURE_STORAGE_CDN_NAME`              | **Yes**  | -             | CDN URL for file delivery, used as prefix for file urls | `https://cdn.indg.com/ams-files-prod`            |

## Service Dependencies Configuration

### PostgreSQL 17 Database

#### Infrastructure Requirements

- **Version**: PostgreSQL 17 (minimum required)
- **SSL/TLS**: Required for production deployments
    - Set `DB_SSL=true` to enable SSL connections
    - For Azure PostgreSQL: Set `DB_SSL_REJECT_UNAUTHORIZED=false` (uses self-signed certificates)
    - For other providers with valid certificates: Keep `DB_SSL_REJECT_UNAUTHORIZED=true`
- **Connection Pooling**: Configured via `DB_MIN_POOL_SIZE` and `DB_MAX_POOL_SIZE`

#### Migration Strategy

- **Automatic Migrations**: Set `DB_RUN_MIGRATIONS=true` for automatic migration execution on startup
- **Migration Files**: Located in `/db/migrations/` directory

### RabbitMQ

- **Exchange**: Application creates required exchanges automatically
- **Queue**: Specify queue name via `RABBITMQ_QUEUE`
- **Shared Instance**: Must use the same RabbitMQ instance as Generator service

### Azure Blob Storage

- **Container**: Must be created manually before deployment
- **Access**: Connection string should have blob read/write permissions
- **CDN**: Optional but recommended for file delivery performance
- **SAS URLs**: Generated automatically with configured expiration times (separate for uploads vs downloads)

## Security Considerations

### Application Security

- **No Authentication**: Service trusts upstream proxy (Odin/Baldr) for authentication
- **Headers Required**: `x-tenant-id`, `x-user-email` must be injected by reverse proxy
- **Internal Service**: Should not be exposed directly to the internet
- **Access Control**: Should be proxied or VPNed for developer access

### Health Checks

- **Application Health**: `GET /healthz` endpoint for service availability


