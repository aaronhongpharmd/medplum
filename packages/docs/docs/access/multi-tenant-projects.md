# Multi Tenant Projects

How can we restrict access to certain resources to practitioners and patients based on criteria like state licensing or organizational membership? 

In Medplum, this can be achieved by applying an `AccessPolicy` that uses utilizes the `Organization` resource in combination with parameterized variables and the `meta.accounts` field on individual resources. 





```mermaid
graph TB
   
    subgraph Project/123
        AP[AccessPolicy/1234<br>multi-tenant-org-policy]

        OrgA[Organization/A]
        PracA[Practitioner/A.1<br>practitioner.a.1@example.com]
        QA[Questionnaire/A.1<br>Experience Rating]
        PatA[Patients<br>Organization/A]

        OrgB[Organization/B]
        PracB[Practitioner/B.1<br>practitioner.b.1@example.com]
        QB[Questionnaire/B.1<br>Experience Rating]
        PatB[Patients<br>Organization B]
    end
    AP --> OrgA
    AP --> OrgB
    
    OrgA --> PracA
    OrgA --> QA
    OrgA --> PatA

    OrgB --> PracB
    OrgB --> QB
    OrgB --> PatB

    classDef project fill:#e6ffe6,stroke:#333,stroke-width:4px
    classDef policy fill:#f9f,stroke:#333,stroke-width:2px
    classDef orgA fill:#e6f3ff,stroke:#333
    classDef orgB fill:#fff3e6,stroke:#333
    
    class AP policy
    class OrgA,PracA,QA,PatA,PRA,QRA,VSA orgA
    class OrgB,PracB,QB,PatB,PRB,QRB,VSB orgB
```
Here's an access policy based on Organization
```json
{
    "resourceType": "AccessPolicy",
    "id": "multi-tenant-org-policy",
    "name": "Multi-Tenant Organization Access Policy",
    "compartment": {
        "reference": "%current_organization"
    },
    "resource": [
        {
            "resourceType": "ValueSet"
        },
        {
            "resourceType": "CodeSet"
        },
        {
            "resourceType": "Organization",
            "criteria": "Organization?_id=%current_organization",
            "readonly": true
        },
        {
            "resourceType": "Practitioner",
            "criteria": "Practitioner?organization=%current_organization"
        },
        {
            "resourceType": "Questionnaire",
            "criteria": "Questionnaire?_compartment=Organization/%current_organization"
        },
        {
            "resourceType": "Patient",
            "criteria": "Patient?organization=%current_organization",
            "readonly": true
        }
    ]
}
```

Here are a couple of organizations to test it
```json
{
    "resourceType": "Organization",
    "name": "Organization A"
}
```

```json
{
    "resourceType": "Organization",
    "name": "Organization B"
}
```
And here are a couple of Resources to go into those organizations

**Organization A**
```json
{
    "resourceType": "Questionnaire",
    "meta": {
        "accounts": [
            {
                "reference": "Organization/{{organization_a}}"
            }
        ]
    },
    "title": "Questionnaire A.1",
    "status": "active",
    "item": [
        {
            "linkId": "1",
            "text": "How would you rate your overall experience?",
            "type": "choice",
            "answerOption": [
                {
                    "valueCoding": {
                        "system": "http://example.org/rating",
                        "code": "5",
                        "display": "Excellent"
                    }
                }
            ]
        }
    ]
}
```
**Organization B**
```json
{
    "resourceType": "Questionnaire",
    "meta": {
        "accounts": [
            {
                "reference": "Organization/{{organization_b}}"
            }
        ]
    },
    "title": "Questionnaire B.1",
    "status": "active",
    "item": [
        {
            "linkId": "1",
            "text": "How would you rate your overall experience?",
            "type": "choice",
            "answerOption": [
                {
                    "valueCoding": {
                        "system": "http://example.org/rating",
                        "code": "5",
                        "display": "Excellent"
                    }
                }
            ]
        }
    ]
}
```
And finally a couple of Practitioners in those organizations

**Practitioner A**
```json
{
    "resourceType": "Practitioner",
    "meta": {
        "accounts": [
            {
                "reference": "Organization/{{organization_a}}"
            }
        ]
    },
    "name": [
        {
            "given": [
                "Practitioner"
            ],
            "family": "A.1"
        }
    ],
    "telecom": [
        {
            "system": "email",
            "use": "work",
            "value": "practitioner.a.1@example.com"
        }
    ]
}
```
**Practitioner B**
```json
{
    "resourceType": "Practitioner",
    "meta": {
        "accounts": [
            {
                "reference": "Organization/{{organization_b}}"
            }
        ]
    },
    "name": [
        {
            "given": [
                "Practitioner"
            ],
            "family": "B.1"
        }
    ],
    "telecom": [
        {
            "system": "email",
            "use": "work",
            "value": "practitioner.b.1@example.com"
        }
    ]
}
```
