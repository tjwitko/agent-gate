terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0.0"
    }
  }
}

# Credentials are deliberately absent. `terraform validate`, which is what the IaC benchmark runs,
# needs none -- and this file is shown to the model as the pattern to imitate, so anything in it is
# something a model may reproduce. It previously carried access_key/secret_key literals, which is
# precisely the shape terraform-guard's hardcoded-credentials rule exists to refuse.
provider "aws" {
  region                      = var.aws_region
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
}

module "logs_bucket" {
  source      = "./modules/storage"
  bucket_name = var.bucket_name
}

output "logs_bucket_name" {
  value = module.logs_bucket.bucket_name
}
