# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the Pearson Career Explorer (PCE) backend - a Spring Boot application that provides APIs for a career assessment and matching platform. The system helps students discover career paths through interactive assessments and matching algorithms.

## Key Technologies & Architecture

- **Framework**: Spring Boot 3.2.0 with Java 21
- **Database**: PostgreSQL with Flyway migrations and jOOQ code generation
- **Security**: Spring Security with JWT authentication (configurable fake auth for development)
- **Data Import**: Spring Batch jobs for importing career/assessment data from Excel files
- **API Documentation**: SpringDoc OpenAPI (Swagger)

## Essential Development Commands

### Environment Setup
```bash
# Copy environment file for local development
cp .env.development .env

# Start PostgreSQL database via Docker
docker-compose up -d
```

### Database Operations
```bash
# Process resources (required before migrations)
./gradlew processResources

# Run database migrations
./gradlew flywayMigrate

# Clean database and re-run all migrations (destructive!)
./gradlew flywayCleanEnabled flywayMigrate

# Generate jOOQ classes after schema changes
./gradlew generateJooq

# Combined: clean DB, migrate, and generate jOOQ
./gradlew clean processResources flywayCleanEnabled flywayMigrate generateJooq
```

### Build & Run
```bash
# Build the application
./gradlew clean build

# Run the application locally
./gradlew bootRun

# Build JAR (output: build/libs/pce-ss.jar)
./gradlew bootJar
```

### Data Import
```bash
# Trigger import job for reference data (careers, questions, etc.)
curl -X POST "http://localhost:8080/api/admin/import-job" -H "Authorization: Bearer dev-login-admin@example.com"
```

### End-to-End Testing
```bash
# Navigate to e2e test directory
cd e2e-test

# Install dependencies
npm install

# Run full student journey integration test
npx tsx studentJourney.ts
```

## Architecture Patterns

### Package Structure
- `api/` - REST controllers and DTOs
- `service/` - Business logic layer
- `security/` - Authentication and authorization
- `config/` - Configuration classes
- `exception/` - Custom exceptions and global exception handling
- `importjob/` - Spring Batch jobs for data import
- `jooq/` - Generated jOOQ classes (build/generated-src/jooq/main)

### Key Design Patterns
- **Service Layer Pattern**: Business logic separated from controllers
- **DTO Pattern**: Request/response objects in `api/dto/`
- **Repository Pattern**: jOOQ for type-safe database access
- **Batch Processing**: Spring Batch for data import workflows
- **Global Exception Handling**: Centralized error handling in `GlobalExceptionHandler`

### Authentication Modes
- **Development**: `AUTH_MODE=fake` - Uses fake JWT tokens like `dev-login-admin@example.com`
- **Production**: `AUTH_MODE=real` - Validates actual JWT tokens with configured public keys

## Database Schema Management

- **Migrations**: Located in `src/main/resources/db/migration/`
- **jOOQ Generation**: Automatically generates type-safe database access classes
- **Schema Documentation**: See `documents/srs/Pce DDL Script v.0.3.sql`

## Important Configuration

- **Environment Variables**: Loaded from `.env` file via `DotEnvLoader`
- **Database Config**: Uses Flyway for migrations, jOOQ for queries
- **Security Config**: JWT-based authentication with role-based access
- **Import Jobs**: Spring Batch configuration for processing Excel data files

## API Documentation

- **Swagger UI**: Available at `http://localhost:8080/swagger-ui/index.html` when running
- **API Specification**: Detailed in `documents/srs/Pce Api Spec v.0.3.txt`
- **Business Logic**: Described in `documents/srs/Pce Business Logic Flows v.0.3.md`

## Testing Strategy

- **Unit Tests**: Standard JUnit tests (none currently present)
- **Integration Tests**: Full e2e test in `e2e-test/` directory using TypeScript
- **Test Dependencies**: Spring Boot Test, Security Test, Testcontainers for PostgreSQL

## Key Business Domains

1. **Student Management**: Registration, authentication, progress tracking
2. **Assessment Engine**: Question delivery, response collection, progress saving
3. **Career Matching**: Algorithm-based career recommendations using attribute scoring
4. **Data Import**: Batch processing of career data, questions, and attributes from Excel files
5. **Teacher Portal**: Class management and student progress monitoring