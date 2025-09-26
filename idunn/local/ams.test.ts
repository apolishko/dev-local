import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import app from '../../../src/server/app/index';
import environmentConfig from '../../../src/server/configuration/environment';
import { setupFakeAMS } from '../../support/server/fakeRemotes/fakeAMS';
import * as amsGateway from '../../../src/server/gateways/ams/index';

describe('AMS RabbitMQ Integration Tests', () => {
  beforeAll(async () => {
    // Initialize configuration first
    await environmentConfig.setup();
    
    // Start the application with web services
    await app.start({ runWeb: true });
    
    // Wait for all services including RabbitMQ to initialize
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Setup fake AMS after everything is ready
    setupFakeAMS();
    
    // Give fake AMS time to setup its queue listener
    await new Promise(resolve => setTimeout(resolve, 4000));
  }, 90000); // Long timeout for full setup

  afterAll(async () => {
    await app.stop();
  }, 30000);

  describe('End-to-End AMS Integration', () => {
    test('should successfully request image asset through RabbitMQ', async () => {
      // Test full request-reply cycle through RabbitMQ
      const asset = await amsGateway.requestAssetById('image-asset-001', {
        tenantId: 'test-tenant',
        userEmail: 'test@example.com'
      });
      
      expect(asset).toBeDefined();
      expect(asset.id).toBe('image-asset-001');
      expect(asset.variations).toBeDefined();
      expect(asset.variations.length).toBeGreaterThan(0);
      
      // Verify structure matches new wire contract
      const variation = asset.variations[0];
      expect(variation.url).toBeDefined();
      expect(variation.mimeType).toBeDefined();
      expect(variation.height).toBeDefined();
    }, 30000);

    test('should successfully request video asset through RabbitMQ', async () => {
      const asset = await amsGateway.requestAssetById('video-asset-001', {
        tenantId: 'test-tenant',
        userEmail: 'test@example.com'
      });
      
      expect(asset).toBeDefined();
      expect(asset.id).toBe('video-asset-001');
      expect(asset.variations).toBeDefined();
      expect(asset.variations.length).toBeGreaterThan(0);
      
      // Check video variation has video mimeType
      const variation = asset.variations[0];
      expect(variation.mimeType).toMatch(/^video\//);
    }, 30000);

    test('should handle asset not found error through RabbitMQ', async () => {
      try {
        await amsGateway.requestAssetById('error-asset-001', {
          tenantId: 'test-tenant',
          userEmail: 'test@example.com'
        });
        
        // Should not reach here
        expect(false).toBe(true);
      } catch (error) {
        expect(error).toBeDefined();
        expect(error.message).toContain('not found');
      }
    }, 30000);
  });

  describe('Wire Contract Validation', () => {
    test('should use exchange-based replies through RabbitMQ', async () => {
      // This test verifies that exchange-based communication works
      const asset = await amsGateway.requestAssetById('image-asset-001', {
        tenantId: 'test-tenant', 
        userEmail: 'test@example.com'
      });
      
      expect(asset).toBeDefined();
      // If we get a response, exchange-based replies are working
      expect(asset.id).toBe('image-asset-001');
    }, 30000);

    test('should handle new response format without success field', async () => {
      // Test that new payload/error format works through RabbitMQ
      const asset = await amsGateway.requestAssetById('image-asset-001', {
        tenantId: 'test-tenant',
        userEmail: 'test@example.com'
      });
      
      expect(asset).toBeDefined();
      expect(asset.variations).toBeDefined();
      
      // Verify no legacy fields are present
      expect(asset).not.toHaveProperty('success');
    }, 30000);
  });

  describe('Asset Download Integration', () => {
    test('should download asset variation buffer', async () => {
      const asset = await amsGateway.requestAssetById('image-asset-001', {
        tenantId: 'test-tenant',
        userEmail: 'test@example.com'
      });
      
      const variation = asset.variations[0];
      const buffer = await amsGateway.downloadVariationBuffer(variation.url);
      
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(0);
    }, 30000);
  });
});