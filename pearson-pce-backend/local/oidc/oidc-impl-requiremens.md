# **Comprehensive OIDC Authentication Implementation Guide**

## **Project Context**

**Application**: Pearson Career Explorer (PCE) Backend - Java 21 Spring Boot application with career assessment game functionality.

**Current State**: Basic dual-mode authentication (`fake`/`real`) with JWT validation. Fake mode works well for development, real mode has basic JWT validation but needs full OIDC implementation.

**Goal**: Implement production-ready OIDC authentication with IES (Identity Enablement Services) while maintaining existing fake mode for development. Support mock mode for testing without external dependencies.

## **Requirements Summary**

### **✅ Must Implement:**
- OIDC/OAuth 2.0 Authorization Code Flow with IES integration
- JWT token validation with standard + custom claims
- Three-role RBAC: Student, Teacher, Admin
- Mock mode for local development (WireMock-based)
- Real mode for production (IES integration)
- Preserve existing fake mode functionality

### **❌ Out of Scope:**
- Complex permission-based ACL system
- Multi-organization hierarchy
- Service-to-service authentication
- Row-level database security
- API Gateway backend implementation

## **Architecture Overview**

### **Authentication Modes:**
1. **`fake`** - Existing development mode with bearer tokens like `dev-login-admin@example.com`
2. **`mock`** - New WireMock-based OIDC simulation for testing
3. **`real`** - Production OIDC with IES integration

### **Security Model:**
- **Application-layer security**: All authorization in services/controllers
- **Role-based access**: `@PreAuthorize("hasRole('STUDENT')")` annotations
- **JWT-based stateless authentication**
- **Standard Spring Security framework**

## **Existing Infrastructure to Leverage**

### **Configuration System:**
- `DotEnvLoader.java` - Environment variable loading
- `AuthProperties.java` - Authentication configuration properties
- `AuthConfig.java` - Spring configuration for auth beans
- `application.properties` - Main configuration file

### **Security Infrastructure:**
- `SecurityConfig.java` - Security filter chain configuration
- `JwtAuthenticationFilter.java` - JWT validation filter
- `JwtPublicKeyProvider.java` - Public key management
- `PceUserDetails.java` - Custom user details
- `SecurityUtils.java` - Role conversion utilities
- `FakeJwtAuthFilter.java` - Existing fake auth filter

### **Exception Handling:**
- `GlobalExceptionHandler.java` - Centralized exception handling
- `AccessForbiddenException.java` - 403 errors
- `ValidationException.java` - Validation failures
- `ResourceNotFoundException.java` - 404 errors

## **Implementation Plan**

### **Phase 1: Configuration Enhancement**

#### **1.1 Extend AuthProperties.java**
Add new configuration classes:
```java
public static class OidcProperties {
    private String issuer;
    private String clientId;
    private String clientSecret;
    private String redirectUri;
    private String jwksUri;
    // getters/setters
}

public static class MockProperties {
    private boolean enabled = false;
    private int serverPort = 9999;
    private String usersFile = "src/test/resources/mock-users.json";
    // getters/setters
}
```

#### **1.2 Update application.properties**
Add OIDC and mock configuration:
```properties
# Authentication Mode: fake, mock, real
auth.mode=${AUTH_MODE:fake}

# OIDC Configuration (real mode)
auth.oidc.issuer=${AUTH_OIDC_ISSUER:}
auth.oidc.client-id=${AUTH_OIDC_CLIENT_ID:}
auth.oidc.client-secret=${AUTH_OIDC_CLIENT_SECRET:}
auth.oidc.redirect-uri=${AUTH_OIDC_REDIRECT_URI:}
auth.jwt.jwks-uri=${AUTH_JWT_JWKS_URI:}

# Mock Configuration (mock mode)
auth.mock.enabled=${AUTH_MOCK_ENABLED:false}
auth.mock.server-port=${AUTH_MOCK_SERVER_PORT:9999}
auth.mock.users-file=${AUTH_MOCK_USERS_FILE:src/test/resources/mock-users.json}
```

#### **1.3 Environment Variables**
Create/update `.env` files:
```bash
# .env.development
AUTH_MODE=fake

# .env.testing  
AUTH_MODE=mock
AUTH_MOCK_ENABLED=true

# .env.production
AUTH_MODE=real
AUTH_OIDC_ISSUER=https://ies.pearson.com
AUTH_OIDC_CLIENT_ID=your-client-id
AUTH_OIDC_CLIENT_SECRET=your-client-secret
AUTH_OIDC_REDIRECT_URI=https://yourapp.com/auth/callback
AUTH_JWT_JWKS_URI=https://ies.pearson.com/.well-known/jwks.json
```

### **Phase 2: Mock Authentication System**

#### **2.1 Create MockAuthServer.java**
WireMock-based OIDC server that simulates IES:
- Authorization endpoint: `/auth/authorize`
- Token endpoint: `/auth/token`
- JWKS endpoint: `/.well-known/jwks.json`
- User info endpoint: `/userinfo`

#### **2.2 Create MockJwtGenerator.java**
Generates realistic JWT tokens with:
- Standard claims: `sub`, `iss`, `exp`, `aud`, `iat`
- Custom claims: `role`, `organization_id`, `login`
- Proper RSA signing for validation

#### **2.3 Create MockUserService.java**
Manages mock user data:
- Loads users from JSON file
- Provides user lookup by login
- Supports different user profiles (student/teacher/admin)

#### **2.4 Create mock-users.json**
Mock user data file:
```json
{
  "users": [
    {
      "login": "student1@school1.com",
      "role": "student",
      "organizationId": "school1",
      "name": "John Student"
    },
    {
      "login": "teacher1@school1.com", 
      "role": "teacher",
      "organizationId": "school1",
      "name": "Jane Teacher"
    },
    {
      "login": "admin@pearson.com",
      "role": "admin", 
      "organizationId": "pearson",
      "name": "Admin User"
    }
  ]
}
```

### **Phase 3: OIDC Implementation**

#### **3.1 Create OidcAuthController.java**
Handle OIDC authentication flow:
- `GET /auth/login` - Redirect to IES authorization
- `GET /auth/callback` - Handle authorization code exchange
- `POST /auth/logout` - Handle logout
- `GET /auth/user` - Get current user info

#### **3.2 Create JwksService.java**
Dynamic JWKS key fetching:
- Cache public keys from JWKS endpoint
- Handle key rotation
- Fallback to configured static key

#### **3.3 Enhance JwtAuthenticationFilter.java**
Add OIDC token validation:
- Support both static and JWKS-based validation
- Validate standard OIDC claims
- Extract custom claims (role, organization_id)

### **Phase 4: Security Enhancement**

#### **4.1 Update SecurityConfig.java**
Configure security based on auth mode:
```java
@Bean
@ConditionalOnProperty(name = "auth.mode", havingValue = "fake")
public OncePerRequestFilter fakeAuthFilter() {
    return new FakeJwtAuthFilter(authProperties);
}

@Bean  
@ConditionalOnProperty(name = "auth.mode", havingValue = "mock")
public OncePerRequestFilter mockAuthFilter() {
    return new MockAuthFilter(authProperties);
}

@Bean
@ConditionalOnProperty(name = "auth.mode", havingValue = "real") 
public OncePerRequestFilter realAuthFilter() {
    return new JwtAuthenticationFilter(authProperties);
}
```

#### **4.2 Add Controller Security**
Add `@PreAuthorize` annotations to controllers:
```java
// StudentController.java
@PreAuthorize("hasRole('STUDENT')")
public ResponseEntity<StudentResponse> getStudent(@PathVariable Long id)

// TeacherController.java  
@PreAuthorize("hasRole('TEACHER')")
public ResponseEntity<List<StudentResponse>> getStudents()

// AdminController.java
@PreAuthorize("hasRole('ADMIN')")
public ResponseEntity<ImportJobExecutionResponse> triggerImport()
```

#### **4.3 Update GlobalExceptionHandler.java**
Add authentication/authorization exception handling:
```java
@ExceptionHandler(JwtException.class)
public ResponseEntity<ErrorResponse> handleJwtException(JwtException ex)

@ExceptionHandler(OAuth2AuthenticationException.class)  
public ResponseEntity<ErrorResponse> handleOAuth2Exception(OAuth2AuthenticationException ex)
```

### **Phase 5: Testing Infrastructure**

#### **5.1 Create AuthFlowIntegrationTest.java**
Test complete authentication flows:
- Mock mode login flow
- JWT token validation
- Role-based access control
- Error scenarios

#### **5.2 Create RoleBasedAccessTest.java**
Test controller security:
- Student access restrictions
- Teacher access permissions
- Admin access permissions
- Cross-role access prevention

### **Phase 6: Dependencies**

#### **6.1 Update build.gradle**
Add required dependencies:
```gradle
implementation 'org.springframework.boot:spring-boot-starter-oauth2-client'
implementation 'org.springframework.boot:spring-boot-starter-oauth2-resource-server'
implementation 'com.nimbusds:nimbus-jose-jwt:9.37.3'
testImplementation 'com.github.tomakehurst:wiremock-jre8:2.35.0'
testImplementation 'org.springframework.security:spring-security-test'
```

## **File Modification Summary**

### **Files to Modify (12 files):**
1. `src/main/java/com/pearson/pce/config/AuthProperties.java` - Add OIDC/mock config
2. `src/main/java/com/pearson/pce/config/AuthConfig.java` - Add mode-specific beans
3. `src/main/java/com/pearson/pce/security/SecurityConfig.java` - Update security chain
4. `src/main/java/com/pearson/pce/security/JwtAuthenticationFilter.java` - Add JWKS support
5. `src/main/java/com/pearson/pce/security/JwtPublicKeyProvider.java` - Dynamic key fetching
6. `src/main/java/com/pearson/pce/security/PceUserDetails.java` - OIDC claims support
7. `src/main/java/com/pearson/pce/api/GlobalExceptionHandler.java` - Auth exception handling
8. `src/main/java/com/pearson/pce/api/StudentController.java` - Add @PreAuthorize
9. `src/main/java/com/pearson/pce/api/TeacherController.java` - Add @PreAuthorize
10. `src/main/java/com/pearson/pce/api/AdminController.java` - Add @PreAuthorize
11. `src/main/java/com/pearson/pce/api/AssessmentController.java` - Add @PreAuthorize
12. `src/main/java/com/pearson/pce/api/GameSaveController.java` - Add @PreAuthorize

### **Files to Add (11 files):**
1. `src/main/java/com/pearson/pce/security/mock/MockAuthServer.java`
2. `src/main/java/com/pearson/pce/security/mock/MockJwtGenerator.java`
3. `src/main/java/com/pearson/pce/security/mock/MockUserService.java`
4. `src/main/java/com/pearson/pce/security/mock/MockAuthFilter.java`
5. `src/main/java/com/pearson/pce/security/oidc/OidcAuthController.java`
6. `src/main/java/com/pearson/pce/security/oidc/JwksService.java`
7. `src/main/java/com/pearson/pce/exception/JwtValidationException.java`
8. `src/test/java/com/pearson/pce/security/AuthFlowIntegrationTest.java`
9. `src/test/java/com/pearson/pce/security/RoleBasedAccessTest.java`
10. `src/test/resources/mock-users.json`
11. `build.gradle` - Add dependencies

### **Configuration Files (3 files):**
1. `src/main/resources/application.properties` - Add OIDC/mock properties
2. `.env.development` - Fake mode config
3. `.env.production` - Real mode config

## **Implementation Notes**

### **Preserve Existing Fake Mode:**
- Keep `FakeJwtAuthFilter.java` unchanged
- Maintain existing fake token format: `Bearer dev-login-admin@example.com`
- Ensure fake mode continues to work for development

### **Error Handling Strategy:**
- Leverage existing `GlobalExceptionHandler.java`
- Reuse existing exceptions where possible
- Add JWT-specific exceptions only where needed

### **Testing Strategy:**
- Mock mode for automated testing
- Fake mode for manual development
- Real mode for production
- Comprehensive integration tests

### **Configuration Pattern:**
- Follow existing patterns from `ImportProperties.java`
- Use `DotEnvLoader.java` for environment variables
- Maintain environment-specific configuration files

This guide provides complete implementation details while leveraging existing infrastructure and maintaining backward compatibility with the fake authentication system.

## **Implementation Clarification - OIDC Provider Integration**

### **Q1: Are we integrating with a specific OIDC provider (like Pearson's identity system)?**

**Answer: Yes - Pearson's IES (Identity Enablement Services)**

- **Primary Provider**: Pearson's IES system
- **Provider URL**: `https://ies.pearson.com` (example)
- **Integration Type**: Standard OIDC/OAuth 2.0 compliant
- **Authentication Method**: Authorization Code Flow for end users
- **Token Format**: JWT tokens with RSA signature validation

### **Q2: Do we need to support multiple OIDC providers?**

**Answer: No - Single Provider Architecture**

- **Single Provider**: Only Pearson IES integration required
- **No Multi-Provider Support**: No need for provider selection logic
- **Simplified Configuration**: Single set of OIDC endpoints
- **Future Extensibility**: Architecture allows adding more providers later if needed, but not a current requirement

### **Q3: Are there specific claim mappings required?**

**Answer: Yes - Specific Claim Structure**

**Required JWT Claims:**
```json
{
  "sub": "user-unique-identifier",
  "iss": "https://ies.pearson.com",
  "aud": "pce-application-id",
  "exp": 1234567890,
  "iat": 1234567890,
  "login": "user@school.com",
  "role": "student|teacher|admin",
  "organization_id": "school-identifier"
}
```

**Claim Mappings:**
- `sub` → User unique identifier
- `login` → User email/login (maps to `PceUserDetails.login`)
- `role` → User role (maps to Spring Security authorities)
- `organization_id` → School/organization identifier (maps to `PceUserDetails.organizationId`)

**Role Mapping:**
- `"student"` → `ROLE_STUDENT`
- `"teacher"` → `ROLE_TEACHER`
- `"admin"` → `ROLE_ADMIN`

### **Q4: Do we need to implement OIDC flows beyond just token validation?**

**Answer: Yes - Full Authorization Code Flow**

**Required OIDC Flows:**

#### **Authorization Code Flow (Primary)**
- **Login Initiation**: `/auth/login` → Redirect to IES
- **Authorization**: User authenticates with IES
- **Callback Handling**: `/auth/callback` → Exchange code for tokens
- **Token Storage**: Store access/refresh tokens (session-based)
- **Token Validation**: Validate JWT on each request

#### **Token Management**
- **Access Token**: Short-lived (15-30 minutes)
- **Refresh Token**: Longer-lived (hours/days)
- **Token Refresh**: Automatic refresh when access token expires
- **Token Revocation**: Logout/session termination

#### **Session Management**
- **Session Creation**: After successful token exchange
- **Session Validation**: JWT validation on each request
- **Session Termination**: Logout endpoint with token revocation

### **Additional Implementation Requirements**

#### **OIDC Client Components:**
```java
// Handle full OIDC flow
@Controller
public class OidcAuthController {
    @GetMapping("/auth/login")
    public String login() {
        // Redirect to IES authorization endpoint
    }
    
    @GetMapping("/auth/callback") 
    public String callback(@RequestParam String code) {
        // Exchange authorization code for tokens
        // Create user session
        // Redirect to application
    }
    
    @PostMapping("/auth/logout")
    public String logout() {
        // Revoke tokens
        // Clear session
        // Redirect to logout page
    }
}
```

#### **Token Management Service:**
```java
@Service
public class TokenService {
    public TokenResponse exchangeCodeForTokens(String code);
    public TokenResponse refreshToken(String refreshToken);
    public void revokeTokens(String accessToken, String refreshToken);
}
```

#### **Session Management:**
```java
@Service
public class SessionService {
    public void createSession(User user, TokenResponse tokens);
    public Optional<User> getCurrentUser();
    public void terminateSession();
}
```

#### **Additional OIDC Configuration:**
```properties
# IES OIDC Endpoints
auth.oidc.authorization-uri=https://ies.pearson.com/auth/authorize
auth.oidc.token-uri=https://ies.pearson.com/auth/token
auth.oidc.user-info-uri=https://ies.pearson.com/userinfo
auth.oidc.end-session-uri=https://ies.pearson.com/auth/logout
auth.oidc.jwks-uri=https://ies.pearson.com/.well-known/jwks.json

# Application Registration
auth.oidc.client-id=pce-application-id
auth.oidc.client-secret=your-secret
auth.oidc.redirect-uri=https://yourapp.com/auth/callback
auth.oidc.scopes=openid,profile,email
```

#### **Mock Implementation Updates:**
```java
@Component
public class MockAuthServer {
    // Simulate full OIDC flow
    public void setupAuthorizationEndpoint();
    public void setupTokenEndpoint();
    public void setupUserInfoEndpoint();
    public void setupJwksEndpoint();
    public void setupLogoutEndpoint();
}
```

#### **Mock User Flow:**
1. User clicks login → Redirects to mock IES
2. Mock IES shows simple user selection page
3. User selects role → Mock generates authorization code
4. Application exchanges code for mock JWT tokens
5. Session created with mock user details

This clarification ensures the implementation covers the complete OIDC integration rather than just token validation, providing a production-ready authentication system.