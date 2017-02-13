import { expect } from 'chai';
import { describe, it } from 'mocha';
import schema from '../server/graphql/schema';
import { graphql } from 'graphql';
import request from 'supertest';
import sinon from 'sinon';

import app from '../server/index';
import * as utils from './utils';
import models from '../server/models';
import roles from '../server/constants/roles';
import * as paymentsLib from '../server/lib/payments';


const application = utils.data('application');

describe('Mutation Tests', () => {
  let user1, user2, group1, event1, tier1;
  let sandbox, createPaymentStub;

  /* SETUP
    group1: 2 events
      event1: 1 free tier, 1 paid tier
  */

  before(() => {
    sandbox = sinon.sandbox.create();
  });

  after(() => sandbox.restore());

  beforeEach(() => {
    createPaymentStub = sandbox.stub(paymentsLib, 'createPayment', () => Promise.resolve());
    //processPaymentStub = sandbox.stub(paymentsLib, 'processPayment');
  });

  // Create a stub for clearbit
  beforeEach((done) => {
    utils.clearbitStubBeforeEach(sandbox);
    done();
  });

  beforeEach(() => utils.resetTestDB());

  beforeEach(() => models.User.create(utils.data('user1')).tap(u => user1 = u));

  beforeEach(() => models.User.create(utils.data('user2')).tap(u => user2 = u));

  beforeEach('create group with user as first member', (done) => {
    request(app)
      .post('/groups')
      .send({
        api_key: application.api_key,
        group: Object.assign({}, utils.data('group1'), { users: [{ email: user1.email, role: roles.HOST}]})
      })
      .expect(200)
      .end((e, res) => {
        expect(e).to.not.exist;
        models.Group
          .findById(parseInt(res.body.id))
          .then((g) => {
            group1 = g;
            done();
          })
          .catch(done);
      });
  });

  beforeEach('create stripe account', (done) => {
    models.StripeAccount.create({
      accessToken: 'abc'
    })
    .then((account) => user1.setStripeAccount(account))
    .tap(() => done())
    .catch(done);
  });

  afterEach(() => {
    utils.clearbitStubAfterEach(sandbox);
  });

  describe('createResponse tests', () => {

    beforeEach(() => models.Event.create(
      Object.assign(utils.data('event1'), { createdByUserId: user1.id, GroupId: group1.id }))
      .tap(e => event1 = e));

    beforeEach(() => models.Tier.create(
      Object.assign(utils.data('tier1'), { EventId: event1.id }))
      .tap(t => tier1 = t));

    beforeEach(() => models.Tier.create(
      Object.assign(utils.data('tier2'), { EventId: event1.id })));

    describe('throws an error', () => {

      it('when missing all required fields', async () => {
        const query = `
          mutation createResponse {
            createResponse(response: {description:"blah"}) {
              id,
              status
              event {
                id
              }
              tier {
                id,
                name,
                description
              }
            }
          }
        `;
        const result = await graphql(schema, query);
        expect(result.errors.length).to.equal(1);
        expect(result.errors[0].message).to.contain('group');
        expect(result.errors[0].message).to.contain('event');
        expect(result.errors[0].message).to.contain('tier');
        expect(result.errors[0].message).to.contain('user');
        expect(result.errors[0].message).to.contain('quantity');
        expect(result.errors[0].message).to.contain('status');
      });

      describe('when collective/event/tier doesn\'t exist', () => {
        
        it('when collective doesn\'t exist', async () => {
          const query = `
            mutation createResponse {
              createResponse(response: { user: { email: "${user1.email}" }, group: { slug: "doesNotExist" }, event: { slug: "${event1.slug}" }, tier: { id: 1 }, status: "YES", quantity:1 }) {
                id,
                status
                event {
                  id
                }
                tier {
                  id,
                  name,
                  description
                }
              }
            }
          `;
          const result = await graphql(schema, query)
          expect(result.errors.length).to.equal(1);
          expect(result.errors[0].message).to.equal('No tier found with tierId:1 for eventSlug:jan-meetup in collectiveSlug:doesNotExist');
        });

        it('when event doesn\'t exist', async () => {
          const query = `
            mutation createResponse {
              createResponse(response: { user: { email:"user@email.com" }, group: { slug: "${group1.slug}" }, event: { slug: "doesNotExist" }, tier: { id:1 }, status:"YES", quantity:1 }) {
                id,
                status
                event {
                  id
                }
                tier {
                  id,
                  name,
                  description
                }
              }
            }
          `;
          const result = await graphql(schema, query);
          expect(result.errors.length).to.equal(1);
          expect(result.errors[0].message).to.equal('No tier found with tierId:1 for eventSlug:doesNotExist in collectiveSlug:scouts');
        });

        it('when tier doesn\'t exist', async () => {
          const query = `
            mutation createResponse {
              createResponse(response: { user: { email: "user@email.com" }, group: { slug: "${group1.slug}" }, event: { slug: "${event1.slug}" }, tier: {id: 1002}, status:"YES", quantity:1 }) {
                id,
                status
                event {
                  id
                }
                tier {
                  id,
                  name,
                  description
                }
              }
            }
          `;
          const result = await graphql(schema, query);
          expect(result.errors.length).to.equal(1);
          expect(result.errors[0].message).to.equal(`No tier found with tierId:1002 for eventSlug:${event1.slug} in collectiveSlug:${group1.slug}`);
        });
      });

      describe('after checking ticket quantity', () => {
        it('and if not enough are available', async () => {
          const query = `
            mutation createResponse {
              createResponse(response: { user: { email: "user@email.com" }, group: { slug: "${group1.slug}" }, event: { slug: "${event1.slug}" }, tier: { id: 1 }, status:"YES", quantity:101 }) {
                id,
                status
                event {
                  id
                }
                tier {
                  id,
                  name,
                  description
                }
              }
            }
          `;
          const result = await graphql(schema, query);
          expect(result.errors[0].message).to.equal(`No more tickets left for ${tier1.name}`);
        });
      });

      describe('when no payment method', () => {
        it('and it\'s a paid tier', async () => {
           const query = `
            mutation createResponse {
              createResponse(response: { user: { email: "user@email.com" }, group: { slug: "${group1.slug}" }, event: { slug: "${event1.slug}" }, tier: { id: 2 }, status:"YES", quantity:2 }) {
                id,
                status
                event {
                  id
                }
                tier {
                  id,
                  name,
                  description
                }
              }
            }
          `;
          const result = await graphql(schema, query);
          expect(result.errors[0].message).to.equal('This tier requires a payment method');
        });
      });
    });

    describe('creates a response', () => {
      
      describe('for a free tier', () => {

        it('from an existing user', async () => {
          const query = `
            mutation createResponse {
              createResponse(response: { user: { email: "${user2.email}" }, group: { slug: "${group1.slug}" }, event: { slug: "${event1.slug}" }, tier: { id: 1 }, status:"YES", quantity:2 }) {
                id,
                status,
                user {
                  id,
                  email
                },
                event {
                  id
                },
                tier {
                  id,
                  name,
                  description,
                  maxQuantity,
                  availableQuantity
                },
                collective {
                  id,
                  slug
                }
              }
            }
          `;
          const result = await graphql(schema, query);
          expect(result).to.deep.equal({
            data: {
              "createResponse": {
                "event": {
                  "id": 1
                },
                "id": 1,
                "status": "YES",
                "tier": {
                  "availableQuantity": 8,
                  "description": "free tickets for all",
                  "id": 1,
                  "maxQuantity": 10,
                  "name": "Free tier"
                },
                "user": {
                  "email": "xdam@opencollective.com",
                  "id": 2
                },
                "collective": {
                  "id": 1,
                  "slug": "scouts"
                }
              }            
            }
          });
        });

        it('from a new user', async () => {
          const query = `
            mutation createResponse {
              createResponse(response: { user: { email: "newuser@email.com" }, group: { slug: "${group1.slug}" }, event: { slug: "${event1.slug}" }, tier: { id: 1 }, status: "YES", quantity: 2 }) {
                id,
                status,
                user {
                  id,
                  email
                },
                event {
                  id
                },
                tier {
                  id,
                  name,
                  description,
                  maxQuantity,
                  availableQuantity
                },
                collective {
                  id,
                  slug
                }
              }
            }
          `;
          const result = await graphql(schema, query);
          expect(result).to.deep.equal({
            data: {
               "createResponse": {
                "event": {
                  "id": 1
                },
                "id": 1,
                "status": "YES",
                "tier": {
                  "availableQuantity": 8,
                  "description": "free tickets for all",
                  "id": 1,
                  "maxQuantity": 10,
                  "name": "Free tier"
                },
                "user": {
                  "email": "newuser@email.com",
                  "id": 3
                },
                "collective": {
                  "id": 1,
                  "slug": "scouts"
                }
              }            
            }
          });
        });        
      });

      describe('for a paid tier', () => {

        it('from an existing user', async () => {
          const query = `
            mutation createResponse {
              createResponse(response: { 
                user: { 
                  email: "${user2.email}",
                  card: {
                    token: "tok_stripe",
                    expMonth: 11,
                    expYear: 2020,
                    number: 4242
                  }
                }, 
                group: { slug: "${group1.slug}" }, 
                event: { slug: "${event1.slug}" }, 
                tier: { id: 2 }, status:"YES", quantity:2 
              }) {
                id,
                status,
                user {
                  id,
                  email
                },
                event {
                  id
                },
                tier {
                  id,
                  name,
                  description,
                  maxQuantity,
                  availableQuantity
                },
                collective {
                  id,
                  slug
                }
              }
            }
          `;
          const result = await graphql(schema, query);
          expect(result).to.deep.equal({
            data: {
              "createResponse": {
                "event": {
                  "id": 1
                },
                "id": 1,
                "status": "YES",
                "tier": {
                  "availableQuantity": 98,
                  "description": "$20 ticket",
                  "id": 2,
                  "maxQuantity": 100,
                  "name": "paid tier"
                },
                "user": {
                  "email": "xdam@opencollective.com",
                  "id": 2
                },
                "collective": {
                  "id": 1,
                  "slug": "scouts"
                }
              }            
            }
          });
          expect(createPaymentStub.callCount).to.equal(1);
          expect(createPaymentStub.firstCall.args[0].user.id).to.equal(2);
          expect(createPaymentStub.firstCall.args[0].group.slug).to.equal('scouts');
          expect(createPaymentStub.firstCall.args[0].response.id).to.equal(1);
          expect(createPaymentStub.firstCall.args[0].payment).to.deep.equal({
            token: 'tok_stripe',
            amount: 4000,
            currency: 'USD',
            description: 'January meetup - paid tier'
          });
        });

        it('from an existing user', async () => {
          const query = `
            mutation createResponse {
              createResponse(response: { 
                user: { 
                  email: "newuser@email.com",
                  card: {
                    token: "tok_stripe",
                    expMonth: 11,
                    expYear: 2020,
                    number: 4242
                  }
                }, 
                group: { slug: "${group1.slug}" }, 
                event: { slug: "${event1.slug}" }, 
                tier: { id: 2 }, status:"YES", quantity:2 
              }) {
                id,
                status,
                user {
                  id,
                  email
                },
                event {
                  id
                },
                tier {
                  id,
                  name,
                  description,
                  maxQuantity,
                  availableQuantity
                },
                collective {
                  id,
                  slug
                }
              }
            }
          `;
          const result = await graphql(schema, query);
          expect(result).to.deep.equal({
            data: {
              "createResponse": {
                "event": {
                  "id": 1
                },
                "id": 1,
                "status": "YES",
                "tier": {
                  "availableQuantity": 98,
                  "description": "$20 ticket",
                  "id": 2,
                  "maxQuantity": 100,
                  "name": "paid tier"
                },
                "user": {
                  "email": "newuser@email.com",
                  "id": 3
                },
                "collective": {
                  "id": 1,
                  "slug": "scouts"
                }
              }            
            }
          });
          expect(createPaymentStub.callCount).to.equal(1);
          expect(createPaymentStub.firstCall.args[0].user.id).to.equal(3);
          expect(createPaymentStub.firstCall.args[0].group.slug).to.equal('scouts');
          expect(createPaymentStub.firstCall.args[0].response.id).to.equal(1);
          expect(createPaymentStub.firstCall.args[0].payment).to.deep.equal({
            token: 'tok_stripe',
            amount: 4000,
            currency: 'USD',
            description: 'January meetup - paid tier'
          });
        });
      });
    }); 
  });
});