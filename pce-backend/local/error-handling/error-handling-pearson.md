# Error Handling Deployment Guide for Pearson Cloud

## Overview
This guide outlines the steps needed to deploy our comprehensive RFC 7807 error handling implementation into Pearson's cloud environment. The system is currently production-ready with MockMonitoringService and needs cloud backend integration.

## 🚀 **Phase 1: Infrastructure Setup & Configuration**

### **1. Environment Variables & Configuration**
```bash
# Production environment variables to set in Pearson cloud
export MONITORING_ENABLED=true
export MONITORING_MOCK=false  # ❗ Key change from development
export MONITORING_ENVIRONMENT=production
export MONITORING_CORRELATION_MODE=dual
export MONITORING_CORRELATION_HEADER=X-Correlation-Id
export MONITORING_RETRY_AFTER_DATABASE_LOCK=30  # Higher for production
```

### **2. Cloud Monitoring Integration**
**Replace MockMonitoringService with real cloud service:**

Create new monitoring service implementation:
```java
// CloudWatchMonitoringService.java
@ConditionalOnProperty(name = "monitoring.mock", havingValue = "false")
@Service
public class CloudWatchMonitoringService implements MonitoringService {
    
    private final CloudWatchClient cloudWatchClient;
    private final SensitiveDataMasker masker;
    
    @Override
    public void captureError(ErrorEvent event) {
        // Send structured error event to AWS CloudWatch
        // Apply masking, truncation, and hashing as configured
    }
    
    @Override
    public void captureMetric(MetricEvent event) {
        // Send custom metrics to CloudWatch
    }
}
```

Or for OpenTelemetry:
```java
// OTELMonitoringService.java
@ConditionalOnProperty(name = "monitoring.backend", havingValue = "otel")
@Service
public class OTELMonitoringService implements MonitoringService {
    
    private final OpenTelemetry openTelemetry;
    
    // Implementation for OTEL backend
}
```

## 🚀 **Phase 2: Metrics & Observability Integration**

### **3. Configure Micrometer for Cloud Backend**

**For AWS CloudWatch:**
```properties
# CloudWatch metrics configuration
management.metrics.export.cloudwatch.enabled=true
management.metrics.export.cloudwatch.namespace=PCE-Backend
management.metrics.export.cloudwatch.region=${AWS_REGION}
management.metrics.export.cloudwatch.accessKeyId=${AWS_ACCESS_KEY_ID}
management.metrics.export.cloudwatch.secretAccessKey=${AWS_SECRET_ACCESS_KEY}

# Step function for metrics publishing
management.metrics.export.cloudwatch.step=PT1M
```

**For Prometheus (if used):**
```properties
# Prometheus metrics configuration
management.metrics.export.prometheus.enabled=true
management.endpoints.web.exposure.include=health,info,metrics,prometheus
management.endpoint.prometheus.enabled=true
```

### **4. Structured Logging Configuration**

Create `logback-spring.xml` for JSON logging:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
    
    <!-- JSON encoder for cloud log aggregation -->
    <appender name="STDOUT" class="ch.qos.logback.core.ConsoleAppender">
        <encoder class="net.logstash.logback.encoder.LoggingEventCompositeJsonEncoder">
            <providers>
                <timestamp/>
                <mdc/>
                <logLevel/>
                <loggerName/>
                <message/>
                <stackTrace/>
            </providers>
        </encoder>
    </appender>
    
    <!-- Separate appender for monitoring events -->
    <appender name="MONITORING" class="ch.qos.logback.core.ConsoleAppender">
        <encoder class="net.logstash.logback.encoder.LoggingEventCompositeJsonEncoder">
            <providers>
                <timestamp/>
                <mdc/>
                <message/>
            </providers>
        </encoder>
    </appender>
    
    <!-- MONITORING logger for structured error events -->
    <logger name="MONITORING" level="INFO" additivity="false">
        <appender-ref ref="MONITORING"/>
    </logger>
    
    <root level="INFO">
        <appender-ref ref="STDOUT"/>
    </root>
    
</configuration>
```

## 🚀 **Phase 3: Security & Compliance**

### **5. Log Aggregation Setup**

**ELK Stack Configuration:**
```yaml
# Elasticsearch index template for error events
PUT _index_template/pce-error-events
{
  "index_patterns": ["pce-errors-*"],
  "template": {
    "mappings": {
      "properties": {
        "timestamp": {"type": "date"},
        "severity": {"type": "keyword"},
        "traceId": {"type": "keyword"},
        "userId": {"type": "keyword"},
        "orgId": {"type": "keyword"},
        "httpStatus": {"type": "integer"},
        "endpoint": {"type": "keyword"},
        "exceptionType": {"type": "keyword"},
        "stackHash": {"type": "keyword"}
      }
    }
  }
}
```

**CloudWatch Logs Configuration:**
- Create log group: `/aws/ecs/pce-backend`
- Set retention: 30 days for INFO, 90 days for ERROR
- Create log insights queries for error analysis

### **6. Alerting & Monitoring Rules**

**CloudWatch Alarms:**
```yaml
# High error rate alarm
HighErrorRate:
  Type: AWS::CloudWatch::Alarm
  Properties:
    AlarmName: PCE-HighErrorRate
    MetricName: http_errors_total
    Namespace: PCE-Backend
    Statistic: Sum
    Period: 300
    Threshold: 50
    ComparisonOperator: GreaterThanThreshold
    EvaluationPeriods: 2

# Authentication failures alarm  
AuthenticationFailures:
  Type: AWS::CloudWatch::Alarm
  Properties:
    AlarmName: PCE-AuthFailures
    MetricName: http_errors_total
    Namespace: PCE-Backend
    Dimensions:
      - Name: status_class
        Value: "4"
    Threshold: 100
    ComparisonOperator: GreaterThanThreshold
```

**Prometheus Alerting Rules:**
```yaml
groups:
  - name: pce-error-handling
    rules:
      - alert: HighErrorRate
        expr: rate(http_errors_total[5m]) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High error rate detected"
          
      - alert: AuthenticationFailures
        expr: increase(http_errors_total{status_class="4"}[1h]) > 100
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "High authentication failure rate"
```

## 🚀 **Phase 4: Database & Infrastructure**

### **7. Production Database Configuration**
```properties
# Production-optimized error handling settings
monitoring.retry-after.database-lock=30  # Longer timeout for production
monitoring.stack.max-size=4096           # Optimized for production
monitoring.stack.max-lines=10            # Reduced for cost efficiency
monitoring.masking.enabled=true          # Always enabled in production

# Database connection settings
spring.datasource.hikari.maximum-pool-size=20
spring.datasource.hikari.minimum-idle=5
spring.datasource.hikari.connection-timeout=30000
```

### **8. Load Balancer & Ingress Configuration**

**ALB/NGINX Configuration:**
```nginx
# Preserve correlation headers
location /api/ {
    proxy_pass http://backend;
    proxy_set_header X-Correlation-Id $http_x_correlation_id;
    proxy_set_header X-Request-Id $http_x_request_id;
    
    # Generate X-Request-Id if not present
    set $request_id $http_x_request_id;
    if ($request_id = "") {
        set $request_id $request_id;
    }
    proxy_set_header X-Request-Id $request_id;
}

# Health check endpoint
location /actuator/health {
    proxy_pass http://backend;
    access_log off;
}
```

**Kubernetes Ingress:**
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: pce-backend-ingress
  annotations:
    nginx.ingress.kubernetes.io/configuration-snippet: |
      more_set_headers "X-Request-Id: $req_id";
spec:
  rules:
    - host: pce-api.pearson.com
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: pce-backend
                port:
                  number: 8080
```

## 🚀 **Phase 5: Deployment & Validation**

### **9. Pre-Deployment Checklist**
```bash
# 1. Build with production profile
./gradlew clean build -Pprofile=production

# 2. Run tests
./gradlew test

# 3. Security scan
./gradlew dependencyCheck

# 4. Validate configuration
java -jar build/libs/pce-ss.jar --spring.config.additional-location=classpath:application-production.properties --dry-run

# 5. Check health endpoint
curl -H "Authorization: Bearer admin-token" \
     https://pce-api.pearson.com/actuator/health

# Expected response:
{
  "status": "UP",
  "components": {
    "db": {"status": "UP"},
    "monitoring": {"status": "UP"}
  }
}
```

### **10. Integration Testing in Production Environment**
```bash
# E2E test with production settings
cd e2e-test
export PCE_BASE_URL=https://pce-api.pearson.com
export AUTH_TOKEN=${PROD_AUTH_TOKEN}
export NODE_ENV=production

# Run comprehensive test suite
npx tsx studentJourney.ts

# Verify error handling specifically
npx tsx errorHandlingTest.ts

# Check correlation tracking
npx tsx correlationTrackingTest.ts
```

**Create errorHandlingTest.ts:**
```typescript
// Test various error scenarios
const tests = [
  { endpoint: '/api/invalid', expectedStatus: 404, expectedType: 'not-found' },
  { endpoint: '/api/students', method: 'POST', body: {}, expectedStatus: 400, expectedType: 'validation' },
  { endpoint: '/api/protected', headers: {}, expectedStatus: 401, expectedType: 'authentication-required' }
];

for (const test of tests) {
  const response = await fetch(`${PCE_BASE_URL}${test.endpoint}`, {
    method: test.method || 'GET',
    body: test.body ? JSON.stringify(test.body) : undefined,
    headers: test.headers || { 'Authorization': `Bearer ${AUTH_TOKEN}` }
  });
  
  const error = await response.json();
  assert(error.status === test.expectedStatus);
  assert(error.type.includes(test.expectedType));
  assert(error.traceId); // Verify correlation tracking
  console.log(`✅ ${test.endpoint}: RFC 7807 error format verified`);
}
```

## 🚀 **Phase 6: Monitoring & Observability**

### **11. Dashboard Setup**

**CloudWatch Dashboard:**
```json
{
  "widgets": [
    {
      "type": "metric",
      "properties": {
        "metrics": [
          ["PCE-Backend", "http.request.duration", "status_class", "2"],
          [".", ".", ".", "4"],
          [".", ".", ".", "5"]
        ],
        "period": 300,
        "stat": "Average",
        "region": "us-east-1",
        "title": "HTTP Response Times by Status Class"
      }
    },
    {
      "type": "metric",
      "properties": {
        "metrics": [
          ["PCE-Backend", "http_errors_total", "status_class", "4"],
          [".", ".", ".", "5"]
        ],
        "period": 300,
        "stat": "Sum",
        "title": "Error Rate by Status Class"
      }
    }
  ]
}
```

**Grafana Dashboard (if using Prometheus):**
```yaml
# grafana-dashboard.json
{
  "dashboard": {
    "title": "PCE Error Handling",
    "panels": [
      {
        "title": "Error Rates",
        "targets": [
          {
            "expr": "rate(http_errors_total[5m])",
            "legendFormat": "{{status_class}}xx errors"
          }
        ]
      },
      {
        "title": "Response Time Percentiles", 
        "targets": [
          {
            "expr": "histogram_quantile(0.95, http_request_duration_bucket)",
            "legendFormat": "P95"
          },
          {
            "expr": "histogram_quantile(0.99, http_request_duration_bucket)", 
            "legendFormat": "P99"
          }
        ]
      }
    ]
  }
}
```

### **12. Log Analysis & Search Queries**

**Elasticsearch Queries:**
```json
# Find authentication errors
{
  "query": {
    "bool": {
      "must": [
        {"term": {"logger": "MONITORING"}},
        {"term": {"httpStatus": 401}},
        {"range": {"@timestamp": {"gte": "now-1h"}}}
      ]
    }
  }
}

# Find high-frequency errors by stack hash
{
  "aggs": {
    "error_groups": {
      "terms": {
        "field": "stackHash",
        "size": 10
      },
      "aggs": {
        "sample": {
          "top_hits": {
            "size": 1,
            "_source": ["exceptionType", "exceptionMessage", "endpoint"]
          }
        }
      }
    }
  }
}
```

**CloudWatch Insights Queries:**
```sql
-- Find correlation ID patterns
fields @timestamp, traceId, endpoint, httpStatus
| filter logger = "MONITORING"
| stats count() by traceId
| sort count desc
| limit 100

-- Analyze error patterns by endpoint
fields @timestamp, endpoint, exceptionType, httpStatus
| filter logger = "MONITORING" and httpStatus >= 400
| stats count() by endpoint, exceptionType
| sort count desc
```

## 🚀 **Phase 7: Production Hardening**

### **13. Security Review & Hardening**
```bash
# Security checklist
✅ Sensitive data masking enabled and tested
✅ 5xx errors don't expose internal details
✅ Error messages are safe for client consumption
✅ Log access is restricted to authorized personnel
✅ Error correlation doesn't leak user information
✅ Stack traces are truncated and hashed
```

**Security Configuration:**
```properties
# Production security settings
monitoring.masking.enabled=true
monitoring.stack.max-size=2048    # Conservative limit
server.error.include-exception=false
server.error.include-stacktrace=never
server.error.include-message=never
```

### **14. Performance Optimization**
```properties
# Production performance tuning
monitoring.stack.max-size=2048
monitoring.stack.max-lines=5
server.tomcat.max-threads=200
server.tomcat.accept-count=100
server.tomcat.connection-timeout=20000

# JVM tuning for monitoring overhead
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200
-Xms2g -Xmx4g

# Async processing for monitoring events
spring.task.execution.pool.core-size=4
spring.task.execution.pool.max-size=8
```

## 🚀 **Phase 8: Rollout Strategy**

### **15. Phased Deployment Plan**

**Stage 1: Canary (5% traffic)**
```bash
# Deploy to canary environment
kubectl apply -f canary-deployment.yaml

# Monitor for 2 hours
watch 'kubectl get pods -l version=canary'

# Check error rates
curl "https://monitoring.pearson.com/api/metrics?query=http_errors_total&env=canary"
```

**Stage 2: Gradual Rollout**
```bash
# 25% traffic
kubectl patch deployment pce-backend -p '{"spec":{"replicas":4}}'
kubectl patch service pce-backend -p '{"spec":{"selector":{"version":"new"}}}'

# Monitor for 4 hours, then 50%, then 100%
```

**Stage 3: Full Deployment**
```bash
# Complete rollout
kubectl rollout status deployment/pce-backend
kubectl get pods -l app=pce-backend

# Verify all instances are healthy
for pod in $(kubectl get pods -l app=pce-backend -o name); do
  kubectl exec $pod -- curl -f localhost:8080/actuator/health
done
```

### **16. Rollback Plan**
```bash
# Emergency rollback procedure
if [ "$ERROR_RATE" -gt "0.05" ]; then
  echo "Rolling back due to high error rate"
  
  # Option 1: Disable monitoring
  kubectl set env deployment/pce-backend MONITORING_ENABLED=false
  kubectl set env deployment/pce-backend MONITORING_MOCK=true
  
  # Option 2: Full rollback
  kubectl rollout undo deployment/pce-backend
  kubectl rollout status deployment/pce-backend
  
  # Verify rollback
  curl https://pce-api.pearson.com/actuator/health
fi
```

---

## 🎯 **Critical Success Factors**

### **❗ Must-Do Items:**
1. **Replace MockMonitoringService** with CloudWatch/OTEL implementation
2. **Configure structured logging** for cloud log aggregation  
3. **Set up correlation headers** in load balancer/ingress
4. **Establish production-optimized limits** for stack traces and metrics
5. **Create monitoring dashboards** for error tracking
6. **Set up alerting rules** for critical error patterns

### **⚠️ Risk Mitigation:**

**Log Volume Management:**
- Use sampling for high-frequency errors
- Implement log level filtering in production
- Set appropriate retention policies

**Performance Impact:**
- Monitor latency impact of error handling
- Use async processing for monitoring events
- Implement circuit breakers for monitoring backends

**Cost Optimization:**
- CloudWatch/metrics can be expensive at scale
- Consider log aggregation and sampling strategies
- Monitor billing alerts for monitoring costs

### **✅ Readiness Validation:**

**Pre-Go-Live Checklist:**
- [ ] All environment variables configured
- [ ] Cloud monitoring service implemented and tested
- [ ] Structured logging working in cloud environment
- [ ] Dashboards and alerts configured
- [ ] Load balancer preserving correlation headers
- [ ] E2E tests passing in production environment
- [ ] Rollback procedures documented and tested
- [ ] Security review completed
- [ ] Performance benchmarks established

---

## 📞 **Support & Escalation**

### **Monitoring Team Contacts:**
- **Primary**: Infrastructure Team
- **Secondary**: Platform Engineering  
- **Escalation**: Site Reliability Engineering

### **Emergency Procedures:**
1. **High Error Rate**: Check dashboards, examine recent deployments
2. **Authentication Issues**: Verify JWT configuration and entry point
3. **Correlation Missing**: Check load balancer configuration
4. **Performance Degradation**: Review monitoring overhead, consider disabling temporarily

---

*This guide assumes our current RFC 7807 error handling implementation is production-ready and only requires cloud backend integration and operational setup.*
*Last updated: 2025-08-12*